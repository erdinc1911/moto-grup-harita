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
// 5) Davet linki: tarayıcıda açılırsa davet sayfası; uygulama yoksa indirme
//    (sadece geçerli bir davet koduyla).
//      GET /katil/<KOD>        -> davet sayfası
//      GET /katil/<KOD>/apk    -> en yeni APK
//      GET /.well-known/assetlinks.json -> Android'in linki uygulamaya bağlaması
//
// 6) Telefon bildirimleri (Firebase Cloud Messaging, ücretsiz):
//      POST /bildirim  { tur: davet | surus | yardim | yorum | basvuru | onay | red, ... }
//    Haftalık zamanlanmış iş (Settings > Trigger events > Cron): süresi biten
//    kampanyaları siler, çok kişinin "kapandı" dediği dükkânları gizler,
//    kampanya özetini bölgelere gönderir.
//
// Ayarlar (Workers > harita > Settings > Variables and Secrets):
//   SES_UYGULAMA   (metin)  Realtime uygulama kimliği (App ID)
//   SES_ANAHTAR    (gizli)  Realtime uygulama anahtarı (App Secret)
//   EPOSTA_ADRESI  (metin)  bildirimlerin gideceği, Cloudflare'de doğrulanmış adres
//   EPOSTA         (bağlantı, Send Email)  e-posta gönderme izni
//   GITHUB_JETON   (gizli)  GitHub okuma anahtarı (moto-grup deposu, Contents: read)
//   FCM_HESAP      (gizli)  Firebase hizmet hesabı anahtarı (JSON dosyasının tamamı)

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
        if (url.pathname === '/bildirim') return await bildirim(istek, env);
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
    if (url.pathname === '/.well-known/assetlinks.json') return assetlinks();
    const davet = url.pathname.match(/^\/katil\/([A-Za-z0-9]{6})(\/apk)?\/?$/);
    if (davet) {
      try {
        const kod = davet[1].toUpperCase();
        return davet[2] ? await davetApk(env, kod) : await davetSayfasi(env, kod, url);
      } catch (e) {
        return new Response('Bir sorun oldu, biraz sonra tekrar dene.', { status: 502 });
      }
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

  // Haftalık zamanlanmış iş (Cloudflare panelinde Cron tetikleyicisi eklenince çalışır).
  async scheduled(olay, env, ctx) {
    ctx.waitUntil(haftalikIs(env).catch(() => {}));
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
  const simdi = Date.now();
  const zamanlar = (bildirimSayaci.get(k.uid) || []).filter((t) => simdi - t < 3600 * 1000);
  if (zamanlar.length >= 10) return json({ tamam: false, sebep: 'sınır' }, 429);
  zamanlar.push(simdi);
  bildirimSayaci.set(k.uid, zamanlar);

  const v = await istek.json().catch(() => ({}));
  const tur = String(v.tur || 'bildirim').slice(0, 40);
  const metin = String(v.metin || '').slice(0, 2000);
  const konu = tur === 'geri_bildirim' ? 'Moto Grup: yeni geri bildirim' : `Moto Grup: yeni şikâyet (${tur})`;
  // Yapımcının telefonuna da bildirim (kuruluysa).
  if (env.FCM_HESAP) {
    await yapimcilaraGonder(env, konu.replace('Moto Grup: ', ''), metin.slice(0, 120),
      tur === 'geri_bildirim' ? 'geri_bildirim' : 'sikayet').catch(() => {});
  }
  if (!env.EPOSTA || !env.EPOSTA_ADRESI) return json({ tamam: true, eposta: false });
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
  // "latest" ön sürümleri görmediği için son birkaç sürüme bakıp en büyüğünü al.
  const y = await fetch(`https://api.github.com/repos/${UYGULAMA_DEPOSU}/releases?per_page=5`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_JETON}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'moto-grup-worker',
    },
  });
  if (!y.ok) throw new Error(`GitHub ${y.status}`);
  let en = null;
  for (const r of await y.json()) {
    if (r.draft) continue;
    const apk = (r.assets || []).find((a) => String(a.name).endsWith('.apk'));
    const no = parseInt(String(r.tag_name || '').replace(/\D/g, ''), 10);
    if (apk && no && (!en || no > en.surum)) en = { surum: no, url: apk.url, boyut: apk.size };
  }
  if (!en) throw new Error('sürüm bulunamadı');
  sonSurum = en;
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
  return apkYaniti(env);
}

async function apkYaniti(env) {
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

// ------------------------------------------------------------- Davet linki

const PAKET = 'com.motogrup.moto_grup';
// Uygulamanın imza sertifikası (tool/test-imza.keystore). Play Store'a çıkınca
// Play'in imza anahtarının parmak izi de eklenmeli.
const IMZA_SHA256 = '63:C1:3A:4D:24:FE:65:2B:8E:D1:54:F6:5F:02:0D:8D:4C:DD:6B:69:F5:59:74:0C:9B:E0:74:9B:EE:69:9B:0D';

function assetlinks() {
  return new Response(JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: PAKET, sha256_cert_fingerprints: [IMZA_SHA256] },
  }]), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
}

/** Davet bilgisi herkese açık okunur (sadece grup adı ve davet edenin adı). */
async function davetBilgisi(kod) {
  const y = await fetch(`${VERITABANI}/davet_bilgi/${kod}.json`);
  if (!y.ok) return null;
  const v = await y.json().catch(() => null);
  return v && typeof v === 'object' ? v : null;
}

function kacis(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function davetApk(env, kod) {
  if (!env.GITHUB_JETON) return new Response('İndirme şu an kapalı.', { status: 503 });
  if (!(await davetBilgisi(kod))) return new Response('Bu davet geçersiz.', { status: 404 });
  return apkYaniti(env);
}

async function davetSayfasi(env, kod, url) {
  const d = await davetBilgisi(kod);
  let surum = null;
  if (d && env.GITHUB_JETON) surum = await enYeniSurum(env).catch(() => null);
  const geriDon = `https://harita.motogrup.app/katil/${kod}?yok=1#indir`;
  const uygulamada = `intent://katil/${kod}#Intent;scheme=motogrup;package=${PAKET};` +
    `S.browser_fallback_url=${encodeURIComponent(geriDon)};end`;
  const yok = url.searchParams.get('yok') === '1';
  const baslik = d ? `${kacis(d.k || 'Bir arkadaşın')} seni <b>"${kacis(d.g || 'grup')}"</b> grubuna davet ediyor` : '';
  const govde = !d ? `
    <h2>Bu davet geçersiz</h2>
    <p>Grup silinmiş ya da link yanlış kopyalanmış olabilir. Davet edenden yeni link iste.</p>` : `
    <p class="davet">${baslik}</p>
    <a class="dugme" href="${uygulamada}">Uygulamada aç</a>
    <p class="kucuk">Grup kodu: <b class="kod">${kod}</b></p>
    <div id="indir" class="kutu${yok ? ' vurgu' : ''}">
      <h3>${yok ? 'Moto Grup telefonunda yüklü değil' : 'Uygulama yüklü değil mi?'}</h3>
      ${surum ? `<a class="dugme ikinci" href="/katil/${kod}/apk">Moto Grup'u indir
        <span>Sürüm ${surum.surum}${surum.boyut ? ` · ${Math.round(surum.boyut / 1048576)} MB` : ''}</span></a>` :
        '<p>İndirme şu an hazır değil; davet edenden uygulamayı iste.</p>'}
      <ol>
        <li><b>İndir</b>'e bas. Dosya inince bildirimden ya da İndirilenler'den aç.</li>
        <li>Telefon <b>"Bu kaynaktan yüklemeye izin ver"</b> derse: Ayarlar'a geç, izni aç, geri dön.</li>
        <li>Google Play Protect <b>"tanınmayan uygulama"</b> derse: <b>Ayrıntılar → Yine de yükle</b>.</li>
        <li>Kurulunca bu sayfaya dön ve <b>Uygulamada aç</b>'a bas. Ya da uygulamada <b>Kodla katıl</b>'a basıp <b>${kod}</b> kodunu gir.</li>
      </ol>
      <p class="kucuk">Moto Grup şu an deneme sürümünde ve Play Store dışından kuruluyor. Play Store'a çıkınca bu sayfa oraya yönlendirecek. Şimdilik yalnızca Android.</p>
    </div>`;
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moto Grup daveti</title>
<meta property="og:title" content="${d ? `${kacis(d.g || 'Grup')} · Moto Grup daveti` : 'Moto Grup'}">
<meta property="og:description" content="Yol arkadaşlığı burada başlar. Katılmak için dokun.">
<style>
body{margin:0;background:#081228;color:#f2f2f0;font-family:system-ui,-apple-system,Roboto,sans-serif;line-height:1.5}
main{max-width:460px;margin:0 auto;padding:32px 20px 48px}
.logo{font-weight:900;letter-spacing:4px;font-size:26px}
.slogan{color:#a3a8b0;margin:2px 0 28px}
.davet{font-size:20px;margin:0 0 18px}
.dugme{display:block;text-align:center;background:#ff7a1a;color:#111;font-weight:800;font-size:18px;
padding:16px;border-radius:14px;text-decoration:none}
.dugme span{display:block;font-weight:500;font-size:13px}
.ikinci{background:#3dd68c}
.kucuk{color:#a3a8b0;font-size:13px}
.kod{color:#ff7a1a;letter-spacing:3px;font-size:16px}
.kutu{background:#17191c;border:1px solid #2c3036;border-radius:14px;padding:16px;margin-top:22px}
.vurgu{border-color:#ff7a1a}
h3{margin:0 0 12px} ol{padding-left:20px} li{margin-bottom:8px}
</style></head><body><main>
<div class="logo">MOTO GRUP</div><div class="slogan">Yol arkadaşlığı burada başlar</div>
${govde}
</main></body></html>`;
  return new Response(html, {
    status: d ? 200 : 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// -------------------------------------------------- Telefon bildirimleri (FCM)

let adminJeton = null;
let adminZamani = 0;

function b64uMetin(s) {
  return b64Utf8(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uBayt(tampon) {
  let ikili = '';
  for (const x of new Uint8Array(tampon)) ikili += String.fromCharCode(x);
  return btoa(ikili).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Hizmet hesabıyla Google erişim jetonu (FCM + veritabanı yöneticisi), ~1 saat geçerli. */
async function adminErisimi(env) {
  if (adminJeton && Date.now() - adminZamani < 50 * 60 * 1000) return adminJeton;
  const h = JSON.parse(env.FCM_HESAP);
  const simdi = Math.floor(Date.now() / 1000);
  const bas = b64uMetin(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const govde = b64uMetin(JSON.stringify({
    iss: h.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: simdi,
    exp: simdi + 3600,
  }));
  const pem = String(h.private_key).replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const anahtar = await crypto.subtle.importKey(
    'pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const imza = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', anahtar, new TextEncoder().encode(`${bas}.${govde}`));
  const y = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${bas}.${govde}.${b64uBayt(imza)}`,
  });
  const j = await y.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Google erişimi alınamadı');
  adminJeton = j.access_token;
  adminZamani = Date.now();
  return adminJeton;
}

async function adminOku(env, yol, sig = false) {
  const t = await adminErisimi(env);
  const y = await fetch(`${VERITABANI}/${yol}.json?access_token=${encodeURIComponent(t)}${sig ? '&shallow=true' : ''}`);
  if (!y.ok) return null;
  return y.json();
}

async function adminYaz(env, yol, deger, yontem = 'PUT') {
  const t = await adminErisimi(env);
  await fetch(`${VERITABANI}/${yol}.json?access_token=${encodeURIComponent(t)}`, {
    method: yontem,
    headers: { 'Content-Type': 'application/json' },
    body: deger === null || deger === undefined ? undefined : JSON.stringify(deger),
  });
}

/** Tek bir cihaza (jeton) ya da konuya bildirim. Geçersiz jetonsa 'gecersiz' döner. */
async function fcmGonder(env, hedef, baslik, metin, tur) {
  const t = await adminErisimi(env);
  const proje = JSON.parse(env.FCM_HESAP).project_id || PROJE;
  const mesaj = {
    notification: { title: String(baslik).slice(0, 100), body: String(metin).slice(0, 240) },
    data: { tur: String(tur) },
    android: { priority: 'HIGH', notification: { channel_id: 'genel' } },
  };
  if (hedef.konu) mesaj.topic = hedef.konu; else mesaj.token = hedef.jeton;
  const y = await fetch(`https://fcm.googleapis.com/v1/projects/${proje}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: mesaj }),
  });
  if (y.status === 404 || y.status === 400) {
    const j = await y.json().catch(() => ({}));
    const s = JSON.stringify(j);
    if (s.includes('UNREGISTERED') || s.includes('INVALID_ARGUMENT')) return 'gecersiz';
  }
  return y.ok ? 'tamam' : 'hata';
}

/** Bir kişiye, kişinin bildirim tercihine bakarak gönderir. */
async function kisiyeGonder(env, uid, baslik, metin, tur, ayar) {
  const b = await adminOku(env, `bildirim/${uid}`);
  if (!b || typeof b.j !== 'string') return false;
  if (ayar === 'grup' && b.grup === false) return false;
  const sonuc = await fcmGonder(env, { jeton: b.j }, baslik, metin, tur);
  if (sonuc === 'gecersiz') await adminYaz(env, `bildirim/${uid}/j`, null, 'DELETE');
  return sonuc === 'tamam';
}

async function yapimcilaraGonder(env, baslik, metin, tur) {
  const y = await adminOku(env, 'yapimci', true);
  if (!y || typeof y !== 'object') return;
  for (const uid of Object.keys(y).slice(0, 5)) await kisiyeGonder(env, uid, baslik, metin, tur, null);
}

/** Grubun diğer üyelerine (sürüşte olmayanlar ya da herkes). Ücretsiz planda istek başına
 *  en fazla 50 alt istek olduğu için ilk 22 kişiyle sınırlı. */
async function grubaGonder(env, g, haric, baslik, metin, tur, ayar, surustekilereDe) {
  const uyeler = await adminOku(env, `gruplar/${g}/uyeler`, true);
  if (!uyeler || typeof uyeler !== 'object') return 0;
  const surusteler = surustekilereDe ? {} : (await adminOku(env, `konumlar/${g}`, true)) || {};
  let n = 0;
  for (const uid of Object.keys(uyeler).filter((u) => u !== haric && !surusteler[u]).slice(0, 22)) {
    if (await kisiyeGonder(env, uid, baslik, metin, tur, ayar)) n++;
  }
  return n;
}

const bildirimGonderimi = new Map(); // uid -> [zamanlar]

async function bildirim(istek, env) {
  const k = await kimlik(istek);
  if (!k) return json({ hata: 'kimlik' }, 401);
  if (!env.FCM_HESAP) return json({ tamam: false, sebep: 'bildirim kurulmadı' });
  const simdi = Date.now();
  const zamanlar = (bildirimGonderimi.get(k.uid) || []).filter((t) => simdi - t < 3600 * 1000);
  if (zamanlar.length >= 30) return json({ tamam: false, sebep: 'sınır' }, 429);
  zamanlar.push(simdi);
  bildirimGonderimi.set(k.uid, zamanlar);

  const v = await istek.json().catch(() => ({}));
  const tur = String(v.tur || '');
  const ad = String((await oku(`kullanicilar/${k.uid}/ad`, k.jeton)) || 'Bir arkadaşın').slice(0, 40);
  const gecerliKimlik = (x) => typeof x === 'string' && /^[\w-]{1,80}$/.test(x);

  if (tur === 'davet' || tur === 'surus' || tur === 'yardim') {
    const g = v.grup;
    if (!gecerliKimlik(g)) return json({ hata: 'grup' }, 400);
    // Gönderen grubun üyesi mi? (kendi yetkisiyle okuyabiliyorsa üyedir)
    const uye = await oku(`gruplar/${g}/uyeler/${k.uid}`, k.jeton);
    if (!uye) return json({ hata: 'üye değil' }, 403);
    const grupAdi = String((await oku(`gruplar/${g}/bilgi/ad`, k.jeton)) || 'grup').slice(0, 40);
    if (tur === 'davet') {
      if (!gecerliKimlik(v.hedef)) return json({ hata: 'hedef' }, 400);
      const ok = await kisiyeGonder(env, v.hedef, 'Grup daveti', `${ad} seni "${grupAdi}" grubuna davet etti`, 'davet', 'grup');
      return json({ tamam: ok });
    }
    if (tur === 'surus') {
      // Aynı grup için yarım saatte bir.
      const son = await adminOku(env, `bildirim_son/${g}`);
      if (typeof son === 'number' && simdi - son < 30 * 60 * 1000) return json({ tamam: false, sebep: 'yakın zamanda gönderildi' });
      await adminYaz(env, `bildirim_son/${g}`, simdi);
      const n = await grubaGonder(env, g, k.uid, `${grupAdi}: sürüş başladı`,
        `${ad} sürüşe başladı. Katılmak için uygulamayı aç.`, 'surus', 'grup', false);
      return json({ tamam: true, kisi: n });
    }
    // Yardım çağrısı: güvenlik için tercihten bağımsız, sürüştekiler dahil herkese.
    const neden = String(v.neden || 'Yardım istiyor').slice(0, 80);
    const n = await grubaGonder(env, g, k.uid, `Yardım çağrısı: ${ad}`, `${grupAdi} · ${neden}`, 'yardim', null, true);
    return json({ tamam: true, kisi: n });
  }
  if (tur === 'yorum') {
    if (!gecerliKimlik(v.dukkan)) return json({ hata: 'dukkan' }, 400);
    const d = await adminOku(env, `dukkan/${v.dukkan}`);
    if (!d || !d.sahip || d.sahip === k.uid) return json({ tamam: false });
    const ok = await kisiyeGonder(env, d.sahip, 'Dükkânına yeni yorum', `${ad} ${d.ad || 'dükkânın'} için yorum yazdı`, 'yorum', null);
    return json({ tamam: ok });
  }
  if (tur === 'basvuru') {
    await yapimcilaraGonder(env, 'Yeni dükkân başvurusu', String(v.ad || '').slice(0, 60), 'basvuru');
    return json({ tamam: true });
  }
  if (tur === 'onay' || tur === 'red') {
    if ((await oku(`yapimci/${k.uid}`, k.jeton)) !== true) return json({ hata: 'yetki' }, 403);
    if (!gecerliKimlik(v.hedef)) return json({ hata: 'hedef' }, 400);
    const dAd = String(v.ad || 'Dükkânın').slice(0, 60);
    const ok = tur === 'onay'
      ? await kisiyeGonder(env, v.hedef, 'Dükkânın onaylandı', `${dAd} artık onaylı. Kampanya ekleyebilir, yorumlara cevap verebilirsin.`, 'onay', null)
      : await kisiyeGonder(env, v.hedef, 'Dükkân başvurun onaylanmadı', `${dAd}: ${String(v.sebep || 'Bilgiler doğrulanamadı').slice(0, 120)}`, 'red', null);
    return json({ tamam: ok });
  }
  return json({ hata: 'bilinmeyen tür' }, 400);
}

// ------------------------------------------------------- Haftalık iş

const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function geohash(lat, lng, uzunluk = 4) {
  let latA = -90, latB = 90, lngA = -180, lngB = 180;
  let s = '', bit = 0, ch = 0, cift = true;
  while (s.length < uzunluk) {
    if (cift) {
      const orta = (lngA + lngB) / 2;
      if (lng >= orta) { ch |= 1 << (4 - bit); lngA = orta; } else { lngB = orta; }
    } else {
      const orta = (latA + latB) / 2;
      if (lat >= orta) { ch |= 1 << (4 - bit); latA = orta; } else { latB = orta; }
    }
    cift = !cift;
    if (bit < 4) { bit++; } else { s += GH32[ch]; bit = 0; ch = 0; }
  }
  return s;
}

/** Uygulamadaki yakinHucreler ile aynı: nokta ve çevresindeki 8 hücre. */
function yakinHucreler(lat, lng) {
  const h = new Set();
  for (const a of [-0.18, 0, 0.18]) for (const b of [-0.35, 0, 0.35]) h.add(geohash(lat + a, lng + b));
  return h;
}

async function haftalikIs(env) {
  if (!env.FCM_HESAP) return;
  const simdi = Date.now();
  let istek = 0; // ücretsiz planda en fazla 50 alt istek
  // 1) Süresi biten kampanyaları sil, geçerlileri bölgelere ayır.
  const kampanyalar = (await adminOku(env, 'kampanyalar')) || {};
  istek += 2;
  const bolgeler = new Map(); // hücre -> [kampanya]
  for (const [id, k] of Object.entries(kampanyalar)) {
    if (!k || typeof k.bitis !== 'number' || k.bitis < simdi) {
      if (istek < 25) { await adminYaz(env, `kampanyalar/${id}`, null, 'DELETE'); istek++; }
      continue;
    }
    if (typeof k.lat !== 'number' || typeof k.lng !== 'number') continue;
    for (const h of yakinHucreler(k.lat, k.lng)) {
      if (!bolgeler.has(h)) bolgeler.set(h, []);
      bolgeler.get(h).push(k);
    }
  }
  // 2) 3 ve daha fazla kişinin "kapandı" dediği, sahipsiz dükkânları gizle.
  const kapandi = (await adminOku(env, 'dukkan_kapandi')) || {};
  istek++;
  for (const [d, kisiler] of Object.entries(kapandi)) {
    if (istek > 32) break;
    if (!kisiler || Object.keys(kisiler).length < 3) continue;
    const onay = await adminOku(env, `dukkan/${d}/onay`);
    istek++;
    if (onay !== true) { await adminYaz(env, `dukkan_gizli/${d}`, true); istek++; }
  }
  // 3) Kampanya özeti: uygulama, isteyen kişiyi bulunduğu hücrenin konusuna abone eder.
  for (const [h, liste] of bolgeler) {
    if (istek >= 48) break;
    const ilk = liste[0];
    const metin = liste.length === 1
      ? `${ilk.dAd || 'Bir dükkân'}: ${ilk.baslik || 'yeni kampanya'}`
      : `${ilk.dAd || 'Bir dükkân'}: ${ilk.baslik || 'kampanya'} ve ${liste.length - 1} kampanya daha`;
    await fcmGonder(env, { konu: `kampanya_${h}` }, `Yakınında ${liste.length} kampanya var`, metin, 'kampanya');
    istek++;
  }
}
