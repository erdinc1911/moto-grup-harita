// Moto Grup aracısı (Cloudflare Workers, ücretsiz plan).
//
// 1) Harita: telefon haritanın küçük parçalarını bu adresten ister; aracı parçayı
//    GitHub'daki harita dosyasından alır ve Cloudflare'in önbelleğinde saklar.
//      GET /surum                     -> güncel harita sürümünün adı
//      GET /<surum>/<bolge>.pmtiles   -> Range ile istenen parça (206)
//
// 2) Canlı ses (Cloudflare Realtime SFU, ayda 1.000 GB ücretsiz): uygulamanın
//    gizli anahtarı burada durur, telefonlara inmez. Her istek Firebase kimlik
//    jetonuyla gelir; jeton Google'ın anahtarlarıyla doğrulanır.
//      POST /ses/hazir | /ses/oturum | /ses/cek | /ses/yenile | /ses/kapat
//
// 3) Bildirim: yeni şikâyet / geri bildirim gelince yapımcıya e-posta.
//      POST /bildir
//
// 4) Güncelleme: uygulama yeni sürümü buradan indirir (GitHub deposu gizli
//    kalır, okuma anahtarı burada durur).
//      POST /guncelleme/bilgi   -> { surum: 44 }
//      GET  /guncelleme/apk     -> en yeni APK
//
// Ayarlar (Workers > harita > Settings > Variables and Secrets):
//   SES_UYGULAMA   (metin)  Realtime uygulama kimliği (App ID)
//   SES_ANAHTAR    (gizli)  Realtime uygulama anahtarı (App Secret)
//   EPOSTA_ADRESI  (metin)  bildirimlerin gideceği, Cloudflare'de doğrulanmış adres
//   EPOSTA         (bağlantı, Send Email)  e-posta gönderme izni
//   GITHUB_JETON   (gizli)  GitHub okuma anahtarı (moto-grup deposu, Contents: read)

import { EmailMessage } from 'cloudflare:email';

const PROJE = 'moto-grup-60040';
const VERITABANI = 'https://moto-grup-60040-default-rtdb.europe-west1.firebasedatabase.app';
const GONDEREN = 'bildirim@motogrup.app';

const DEPO = 'https://github.com/erdinc1911/moto-grup-harita/releases';
const EN_BUYUK_PARCA = 8 * 1024 * 1024; // daha büyük istekler önbelleğe alınmaz
const imzaliAdresler = new Map(); // dosya -> { adres, zaman }

export default {
  async fetch(istek, env, ctx) {
    const url = new URL(istek.url);
    if (istek.method === 'POST') {
      try {
        if (url.pathname.startsWith('/ses/')) return await ses(istek, env, url.pathname.slice(5));
        if (url.pathname === '/bildir') return await bildir(istek, env);
        if (url.pathname === '/guncelleme/bilgi') return await guncellemeBilgi(istek, env);
      } catch (e) {
        return json({ hata: String(e && e.message ? e.message : e) }, 502);
      }
      return new Response('Bulunamadı', { status: 404 });
    }
    if (url.pathname === '/guncelleme/apk' && istek.method === 'GET') {
      try {
        return await guncellemeApk(istek, env);
      } catch (e) {
        return json({ hata: String(e && e.message ? e.message : e) }, 502);
      }
    }
    if (istek.method !== 'GET' && istek.method !== 'HEAD') {
      return new Response('Yöntem desteklenmiyor', { status: 405 });
    }
    if (url.pathname === '/surum') return surum(ctx);

    const m = url.pathname.match(/^\/(harita-\d{8})\/([a-z]+\.pmtiles)$/);
    if (!m) return new Response('Bulunamadı', { status: 404 });
    const [, etiket, dosya] = m;
    const kaynak = `${DEPO}/download/${etiket}/${dosya}`;

    const aralik = istek.headers.get('Range');
    // Dosyanın tamamı (bölge indirme): doğrudan GitHub'a yönlendir.
    if (!aralik) return Response.redirect(kaynak, 302);
    const r = aralik.match(/^bytes=(\d+)-(\d+)$/);
    if (!r || Number(r[2]) - Number(r[1]) + 1 > EN_BUYUK_PARCA) {
      return Response.redirect(kaynak, 302);
    }

    // Sürüm adı anahtarda olduğu için önbellek hiç eskimez.
    const anahtar = new Request(`https://onbellek.motogrup.app/${etiket}/${dosya}?r=${r[1]}-${r[2]}`);
    const onbellek = caches.default;
    const kayitli = await onbellek.match(anahtar);
    if (kayitli) return parcaYaniti(kayitli);

    let yanit = await githubdanAl(kaynak, dosya, aralik);
    if (yanit.status === 401 || yanit.status === 403) {
      imzaliAdresler.delete(kaynak);
      yanit = await githubdanAl(kaynak, dosya, aralik);
    }
    if (yanit.status !== 206) {
      return new Response('Harita kaynağı yanıt vermedi', { status: 502 });
    }
    const govde = await yanit.arrayBuffer();
    const saklanacak = new Response(govde, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Range': yanit.headers.get('Content-Range') || '',
        'Content-Type': 'application/octet-stream',
      },
    });
    ctx.waitUntil(onbellek.put(anahtar, saklanacak.clone()));
    return parcaYaniti(saklanacak);
  },
};

function parcaYaniti(kayitli) {
  return new Response(kayitli.body, {
    status: 206,
    headers: {
      'Content-Range': kayitli.headers.get('X-Content-Range'),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// GitHub dosyası imzalı, süreli bir adrese yönlendirir; o adresi birkaç dakika sakla.
async function githubdanAl(kaynak, dosya, aralik) {
  const anahtar = kaynak;
  let kayit = imzaliAdresler.get(anahtar);
  if (!kayit || Date.now() - kayit.zaman > 5 * 60 * 1000) {
    const y = await fetch(kaynak, { redirect: 'manual', headers: { Range: 'bytes=0-0' } });
    const yer = y.headers.get('Location');
    kayit = { adres: yer ? new URL(yer, kaynak).toString() : kaynak, zaman: Date.now() };
    imzaliAdresler.set(anahtar, kayit);
  }
  return fetch(kayit.adres, { headers: { Range: aralik } });
}

// Güncel harita sürümünün adı: /releases/latest -> /releases/tag/harita-XXXX
async function surum(ctx) {
  const anahtar = new Request('https://onbellek.motogrup.app/surum');
  const kayitli = await caches.default.match(anahtar);
  if (kayitli) return kayitli;
  const y = await fetch(`${DEPO}/latest`, { redirect: 'manual' });
  const yer = y.headers.get('Location') || '';
  const m = yer.match(/\/tag\/(harita-\d{8})/);
  if (!m) return new Response('Sürüm bulunamadı', { status: 502 });
  const yanit = new Response(m[1], {
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=600' },
  });
  ctx.waitUntil(caches.default.put(anahtar, yanit.clone()));
  return yanit;
}

// ------------------------------------------------------------------ Ortak

function json(veri, durum = 200) {
  return new Response(JSON.stringify(veri), {
    status: durum,
    headers: { 'Content-Type': 'application/json' },
  });
}

function b64uCoz(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

let googleAnahtarlari = null;
let anahtarZamani = 0;

async function anahtarlariAl() {
  if (googleAnahtarlari && Date.now() - anahtarZamani < 3600 * 1000) return googleAnahtarlari;
  const y = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  googleAnahtarlari = (await y.json()).keys || [];
  anahtarZamani = Date.now();
  return googleAnahtarlari;
}

/** Firebase kimlik jetonunu doğrular: { uid, jeton } ya da null. */
async function kimlik(istek) {
  const b = istek.headers.get('Authorization') || '';
  const jeton = b.startsWith('Bearer ') ? b.slice(7) : '';
  const [bas, govde, imza] = jeton.split('.');
  if (!imza) return null;
  try {
    const baslik = JSON.parse(new TextDecoder().decode(b64uCoz(bas)));
    const veri = JSON.parse(new TextDecoder().decode(b64uCoz(govde)));
    const simdi = Date.now() / 1000;
    if (veri.aud !== PROJE || veri.iss !== `https://securetoken.google.com/${PROJE}`) return null;
    if (!veri.sub || veri.exp < simdi || veri.iat > simdi + 300) return null;
    const jwk = (await anahtarlariAl()).find((k) => k.kid === baslik.kid);
    if (!jwk) return null;
    const anahtar = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const dogru = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', anahtar, b64uCoz(imza), new TextEncoder().encode(`${bas}.${govde}`));
    return dogru ? { uid: veri.sub, jeton } : null;
  } catch (_) {
    return null;
  }
}

/** Firebase'den, kullanıcının kendi yetkisiyle okur. */
async function oku(yol, jeton) {
  const y = await fetch(`${VERITABANI}/${yol}.json?auth=${encodeURIComponent(jeton)}`);
  if (!y.ok) return null;
  return y.json();
}

// ------------------------------------------------------------- Canlı ses

async function sfu(env, yol, yontem, govde) {
  const y = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${env.SES_UYGULAMA}${yol}`, {
    method: yontem,
    headers: { Authorization: `Bearer ${env.SES_ANAHTAR}`, 'Content-Type': 'application/json' },
    body: govde ? JSON.stringify(govde) : undefined,
  });
  const j = await y.json().catch(() => ({}));
  if (!y.ok || j.errorCode) throw new Error(j.errorDescription || `SFU ${y.status}`);
  return j;
}

async function sesEngelli(k, grup) {
  const kisi = await oku(`ses_engel/${k.uid}`, k.jeton);
  const g = grup ? await oku(`ses_engel_grup/${grup}`, k.jeton) : null;
  return kisi === true || g === true;
}

async function ses(istek, env, islem) {
  const k = await kimlik(istek);
  if (!k) return json({ hata: 'kimlik' }, 401);
  const v = await istek.json().catch(() => ({}));
  const hazir = !!(env.SES_UYGULAMA && env.SES_ANAHTAR);

  if (islem === 'hazir') {
    return json({ hazir, engelli: hazir ? await sesEngelli(k, v.grup) : false });
  }
  if (!hazir) return json({ hata: 'ses kurulmadı' }, 503);

  if (islem === 'oturum') {
    // Engelli kişi ya da grup bağlanamaz (uygulama değiştirilse bile).
    if (await sesEngelli(k, v.grup)) return json({ hata: 'engelli' }, 403);
    if (typeof v.sdp !== 'string' || !v.mid) return json({ hata: 'eksik' }, 400);
    const o = await sfu(env, '/sessions/new', 'POST');
    const t = await sfu(env, `/sessions/${o.sessionId}/tracks/new`, 'POST', {
      sessionDescription: { type: 'offer', sdp: v.sdp },
      tracks: [{ location: 'local', mid: String(v.mid), trackName: 'ses' }],
    });
    return json({ oturum: o.sessionId, sdp: t.sessionDescription && t.sessionDescription.sdp });
  }
  if (typeof v.oturum !== 'string' || !/^[\w-]{8,100}$/.test(v.oturum)) {
    return json({ hata: 'oturum' }, 400);
  }
  if (islem === 'cek') {
    const kaynaklar = Array.isArray(v.kaynaklar) ? v.kaynaklar.slice(0, 25) : [];
    if (!kaynaklar.length) return json({ tracks: [] });
    const t = await sfu(env, `/sessions/${v.oturum}/tracks/new`, 'POST', {
      tracks: kaynaklar.map((x) => ({
        location: 'remote',
        sessionId: String(x.oturum),
        trackName: String(x.iz || 'ses'),
      })),
    });
    return json(t);
  }
  if (islem === 'yenile') {
    await sfu(env, `/sessions/${v.oturum}/renegotiate`, 'PUT', {
      sessionDescription: { type: 'answer', sdp: String(v.sdp || '') },
    });
    return json({ tamam: true });
  }
  if (islem === 'kapat') {
    const midler = Array.isArray(v.midler) ? v.midler.slice(0, 25) : [];
    if (midler.length) {
      await sfu(env, `/sessions/${v.oturum}/tracks/close`, 'PUT', {
        tracks: midler.map((mid) => ({ mid: String(mid) })),
        force: true,
      });
    }
    return json({ tamam: true });
  }
  return json({ hata: 'bilinmeyen işlem' }, 404);
}

// ---------------------------------------------------------- E-posta bildirimi

const bildirimSayaci = new Map(); // uid -> [zamanlar] (kötüye kullanım sınırı)

function b64Utf8(s) {
  const b = new TextEncoder().encode(s);
  let ikili = '';
  for (const x of b) ikili += String.fromCharCode(x);
  return btoa(ikili);
}

async function bildir(istek, env) {
  const k = await kimlik(istek);
  if (!k) return json({ hata: 'kimlik' }, 401);
  if (!env.EPOSTA || !env.EPOSTA_ADRESI) return json({ tamam: false, sebep: 'e-posta kurulmadı' });
  const simdi = Date.now();
  const zamanlar = (bildirimSayaci.get(k.uid) || []).filter((t) => simdi - t < 3600 * 1000);
  if (zamanlar.length >= 10) return json({ tamam: false, sebep: 'sınır' }, 429);
  zamanlar.push(simdi);
  bildirimSayaci.set(k.uid, zamanlar);

  const v = await istek.json().catch(() => ({}));
  const tur = String(v.tur || 'bildirim').slice(0, 40);
  const metin = String(v.metin || '').slice(0, 2000);
  const konu = tur === 'geri_bildirim' ? 'Moto Grup: yeni geri bildirim' : `Moto Grup: yeni şikâyet (${tur})`;
  const govde = `${metin}\n\nGönderen kimliği: ${k.uid}\nAyrıntılar uygulamadaki yapımcı panelinde.`;
  const ham = [
    `From: Moto Grup <${GONDEREN}>`,
    `To: ${env.EPOSTA_ADRESI}`,
    `Subject: =?UTF-8?B?${b64Utf8(konu)}?=`,
    `Message-ID: <${crypto.randomUUID()}@motogrup.app>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Utf8(govde),
  ].join('\r\n');
  await env.EPOSTA.send(new EmailMessage(GONDEREN, env.EPOSTA_ADRESI, ham));
  return json({ tamam: true });
}

// --------------------------------------------------------------- Güncelleme

const UYGULAMA_DEPOSU = 'erdinc1911/moto-grup';
let sonSurum = null;
let sonSurumZamani = 0;

async function enYeniSurum(env) {
  if (sonSurum && Date.now() - sonSurumZamani < 5 * 60 * 1000) return sonSurum;
  const y = await fetch(`https://api.github.com/repos/${UYGULAMA_DEPOSU}/releases/latest`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_JETON}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'moto-grup-worker',
    },
  });
  if (!y.ok) throw new Error(`GitHub ${y.status}`);
  const r = await y.json();
  const apk = (r.assets || []).find((a) => String(a.name).endsWith('.apk'));
  const no = parseInt(String(r.tag_name || '').replace(/\D/g, ''), 10);
  if (!apk || !no) throw new Error('sürüm bulunamadı');
  sonSurum = { surum: no, url: apk.url, boyut: apk.size };
  sonSurumZamani = Date.now();
  return sonSurum;
}

async function guncellemeBilgi(istek, env) {
  const k = await kimlik(istek);
  if (!k) return json({ hata: 'kimlik' }, 401);
  if (!env.GITHUB_JETON) return json({ hata: 'güncelleme kurulmadı' }, 503);
  const s = await enYeniSurum(env);
  return json({ surum: s.surum, boyut: s.boyut });
}

async function guncellemeApk(istek, env) {
  const k = await kimlik(istek);
  if (!k) return json({ hata: 'kimlik' }, 401);
  if (!env.GITHUB_JETON) return json({ hata: 'güncelleme kurulmadı' }, 503);
  const s = await enYeniSurum(env);
  // GitHub dosyayı imzalı bir adrese yönlendirir; o adrese anahtarsız gidilir.
  const y = await fetch(s.url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_JETON}`,
      Accept: 'application/octet-stream',
      'User-Agent': 'moto-grup-worker',
    },
    redirect: 'manual',
  });
  let dosya = y;
  if (y.status >= 300 && y.status < 400) {
    dosya = await fetch(y.headers.get('Location'), { headers: { 'User-Agent': 'moto-grup-worker' } });
  }
  if (!dosya.ok) throw new Error(`indirme ${dosya.status}`);
  return new Response(dosya.body, {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': dosya.headers.get('Content-Length') || String(s.boyut || ''),
      'Content-Disposition': `attachment; filename="moto-grup-surum-${s.surum}.apk"`,
    },
  });
}
