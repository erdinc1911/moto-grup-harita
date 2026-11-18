#!/usr/bin/env python3
"""Türkiye'nin virajlı yollarını OpenStreetMap verisinden çıkarır.

Kullanım: virajli.py yollar.osm.pbf yerler.osm.pbf cikti.json.gz

Yöntem (adamfranco/curvature'a benzer):
  * Aynı adlı / numaralı ya da kesintisiz devam eden yol parçaları birleştirilir.
  * Her noktada önceki ve sonraki noktadan geçen çemberin yarıçapı bulunur.
  * Yarıçapı küçük (keskin) kısımların uzunluğu ağırlıklı toplanır:
      < 30 m: x2, < 60 m: x1.6, < 100 m: x1.3, < 175 m: x1, düz: 0
  * 2 km'den uzun düzlüklerde yol bölünür; böylece virajlı kısım ayrı görünür.
"""
import gzip
import json
import math
import sys
from datetime import date

YER_YARICAPI = 6371000.0
ESIK_PUAN = 500          # bu puanın altı "virajlı" sayılmaz
EN_KISA = 1500           # metre
DUZLUK_BOL = 2000        # metre; bu kadar düz yol varsa ikiye böl
EN_FAZLA_YOL = 12000
SADELESTIR = 5.0         # metre; çizgi sadeleştirme toleransı
SINIF = {
    'trunk': 'ana', 'primary': 'ana', 'secondary': 'il',
    'tertiary': 'yerel', 'unclassified': 'koy',
}
SINIF_SIRA = {'ana': 0, 'il': 1, 'yerel': 2, 'koy': 3}
TOPRAK = {'unpaved', 'gravel', 'dirt', 'ground', 'sand', 'grass', 'mud',
          'earth', 'fine_gravel', 'compacted', 'pebblestone', 'rock'}


# ------------------------------------------------------------------ geometri

def yerel_xy(noktalar):
    """(enlem, boylam) listesini metre cinsinden düzlem koordinatına çevirir."""
    lat0 = noktalar[0][0]
    kx = math.cos(math.radians(lat0)) * math.pi / 180 * YER_YARICAPI
    ky = math.pi / 180 * YER_YARICAPI
    return [((lon - noktalar[0][1]) * kx, (lat - lat0) * ky) for lat, lon in noktalar]


def yaricap(a, b, c):
    ab = math.dist(a, b)
    bc = math.dist(b, c)
    ca = math.dist(c, a)
    capraz = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    if capraz < 1e-9:
        return math.inf
    return ab * bc * ca / (2 * capraz)


def agirlik(r):
    if r < 30:
        return 2.0
    if r < 60:
        return 1.6
    if r < 100:
        return 1.3
    if r < 175:
        return 1.0
    return 0.0


def seyrelt(xy, noktalar, en_az=3.0):
    """Birbirine 3 m'den yakın noktaları at (yoğun çizimde sahte keskin viraj olmasın)."""
    sx, sn = [xy[0]], [noktalar[0]]
    for i in range(1, len(xy)):
        if math.dist(xy[i], sx[-1]) >= en_az or i == len(xy) - 1:
            sx.append(xy[i])
            sn.append(noktalar[i])
    return sx, sn


def parcalar(noktalar):
    """Bir yol zincirini virajlı parçalara böler. (bas, son, uzunluk, puan) üretir."""
    if len(noktalar) < 3:
        return [], noktalar
    xy, noktalar = seyrelt(yerel_xy(noktalar), noktalar)
    n = len(xy)
    if n < 3:
        return [], noktalar
    r = [math.inf] * n
    for i in range(1, n - 1):
        r[i] = yaricap(xy[i - 1], xy[i], xy[i + 1])
    boy = [math.dist(xy[i], xy[i + 1]) for i in range(n - 1)]
    agr = [agirlik(min(r[i], r[i + 1])) for i in range(n - 1)]

    sonuc = []
    bas = None       # parçanın ilk virajlı kesimi
    son = None       # parçanın son virajlı kesimi
    duz = 0.0        # son virajdan beri düz giden mesafe
    for i in range(n - 1):
        if agr[i] > 0:
            if bas is None:
                bas = i
            elif duz > DUZLUK_BOL:
                sonuc.append((bas, son + 1))
                bas = i
            son = i
            duz = 0.0
        elif bas is not None:
            duz += boy[i]
    if bas is not None:
        sonuc.append((bas, son + 1))

    cikti = []
    for b, s in sonuc:
        uzunluk = sum(boy[b:s])
        puan = sum(boy[i] * agr[i] for i in range(b, s))
        cikti.append((b, s, uzunluk, puan))
    return cikti, noktalar


def sadelestir(noktalar, tolerans=SADELESTIR):
    """Ramer-Douglas-Peucker (yığınla)."""
    if len(noktalar) < 3:
        return noktalar
    xy = yerel_xy(noktalar)
    tut = [False] * len(xy)
    tut[0] = tut[-1] = True
    yigin = [(0, len(xy) - 1)]
    while yigin:
        b, s = yigin.pop()
        if s <= b + 1:
            continue
        ax, ay = xy[b]
        bx, by = xy[s]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        en, ei = -1.0, b
        for i in range(b + 1, s):
            px, py = xy[i]
            t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
            d = math.hypot(ax + t * dx - px, ay + t * dy - py)
            if d > en:
                en, ei = d, i
        if en > tolerans:
            tut[ei] = True
            yigin.append((b, ei))
            yigin.append((ei, s))
    return [p for p, t in zip(noktalar, tut) if t]


def kodla(noktalar):
    """Google encoded polyline (5 basamak)."""
    cikti = []
    olat = olng = 0
    for lat, lng in noktalar:
        ilat, ilng = round(lat * 1e5), round(lng * 1e5)
        for d in (ilat - olat, ilng - olng):
            v = ~(d << 1) if d < 0 else (d << 1)
            while v >= 0x20:
                cikti.append(chr((0x20 | (v & 0x1f)) + 63))
                v >>= 5
            cikti.append(chr(v + 63))
        olat, olng = ilat, ilng
    return ''.join(cikti)


# ------------------------------------------------------------------ birleştirme

def zincirle(yollar):
    """yollar: [{'id', 'anahtar', 'ilk', 'son', 'n': [(lat, lon)], 'sinif'}]
    Uç uca eklenen yolları birleştirir; [(id listesi, noktalar, sinif)] döner."""
    uclar = {}
    for i, y in enumerate(yollar):
        if y['ilk'] == y['son']:
            continue  # kapalı halka
        uclar.setdefault(y['ilk'], []).append((i, 0))
        uclar.setdefault(y['son'], []).append((i, 1))

    es = {}
    for liste in uclar.values():
        if len(liste) == 2:
            (a, ea), (b, eb) = liste
            ka, kb = yollar[a]['anahtar'], yollar[b]['anahtar']
            if a != b and (ka == kb or not ka or not kb):
                es[(a, ea)] = (b, eb)
                es[(b, eb)] = (a, ea)
            continue
        gruplar = {}
        for i, e in liste:
            k = yollar[i]['anahtar']
            if k:
                gruplar.setdefault(k, []).append((i, e))
        for g in gruplar.values():
            if len(g) == 2 and g[0][0] != g[1][0]:
                es[g[0]] = g[1]
                es[g[1]] = g[0]

    gorulen = [False] * len(yollar)
    sonuc = []
    for basla in range(len(yollar)):
        if gorulen[basla]:
            continue
        # Zincirin başına git.
        cur, giris = basla, 0
        adim = 0
        while True:
            p = es.get((cur, giris))
            if p is None or p[0] == basla or adim > len(yollar):
                break
            cur, giris = p[0], 1 - p[1]
            adim += 1
        # Baştan sona yürü.
        ids, noktalar, sinif = [], [], 'koy'
        while cur is not None and not gorulen[cur]:
            gorulen[cur] = True
            y = yollar[cur]
            parca = y['n'] if giris == 0 else y['n'][::-1]
            noktalar.extend(parca if not noktalar else parca[1:])
            ids.append(y['id'])
            if SINIF_SIRA[y['sinif']] < SINIF_SIRA[sinif]:
                sinif = y['sinif']
            p = es.get((cur, 1 - giris))
            if p is None:
                break
            cur, giris = p
        sonuc.append((ids, noktalar, sinif))
    return sonuc


# ------------------------------------------------------------------ yer adları

class YerIzgarasi:
    def __init__(self, hucre):
        self.hucre = hucre
        self.izgara = {}

    def ekle(self, lat, lon, ad):
        k = (int(lat // self.hucre), int(lon // self.hucre))
        self.izgara.setdefault(k, []).append((lat, lon, ad))

    def en_yakin(self, lat, lon, halka=2):
        ky, kx = int(lat // self.hucre), int(lon // self.hucre)
        en, ad = math.inf, ''
        kc = math.cos(math.radians(lat))
        for h in range(halka + 1):
            for dy in range(-h, h + 1):
                for dx in range(-h, h + 1):
                    if max(abs(dy), abs(dx)) != h:
                        continue
                    for y, x, a in self.izgara.get((ky + dy, kx + dx), ()):
                        d = (y - lat) ** 2 + ((x - lon) * kc) ** 2
                        if d < en:
                            en, ad = d, a
            if ad and h >= 1:
                break
        return ad


# ------------------------------------------------------------------ OSM okuma

def oku(yollar_pbf, yerler_pbf):
    import osmium

    yollar = []
    sehirler = YerIzgarasi(1.0)
    koyler = YerIzgarasi(0.1)

    class YolOkuyucu(osmium.SimpleHandler):
        def way(self, w):
            t = w.tags
            sinif = SINIF.get(t.get('highway', ''))
            if sinif is None:
                return
            if t.get('oneway') in ('yes', '1', '-1'):
                return  # bölünmüş yolun tek yönü; ya da tek yönlü sokak
            if t.get('surface', '') in TOPRAK or t.get('area') == 'yes':
                return
            if t.get('access') in ('no', 'private'):
                return
            try:
                n = [(nd.location.lat, nd.location.lon) for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            if len(n) < 2:
                return
            ad = t.get('name', '') or ''
            ref = t.get('ref', '') or ''
            yollar.append({
                'id': w.id,
                'ad': ad,
                'ref': ref,
                'anahtar': (ad or ref).strip().lower(),
                'ilk': w.nodes[0].ref,
                'son': w.nodes[-1].ref,
                'n': n,
                'sinif': sinif,
            })

    class YerOkuyucu(osmium.SimpleHandler):
        def node(self, nd):
            tur = nd.tags.get('place')
            ad = nd.tags.get('name:tr') or nd.tags.get('name')
            if not tur or not ad:
                return
            lat, lon = nd.location.lat, nd.location.lon
            if tur == 'city':
                sehirler.ekle(lat, lon, ad)
            if tur in ('city', 'town', 'village'):
                koyler.ekle(lat, lon, ad)

    YolOkuyucu().apply_file(yollar_pbf, locations=True, idx='flex_mem')
    YerOkuyucu().apply_file(yerler_pbf)
    return yollar, sehirler, koyler


def hesapla(yollar, sehirler, koyler):
    adlar = {y['id']: (y['ad'], y['ref']) for y in yollar}
    sonuc = []
    for ids, noktalar, sinif in zincirle(yollar):
        pr, temiz = parcalar(noktalar)
        for k, (b, s, uzunluk, puan) in enumerate(pr):
            if puan < ESIK_PUAN or uzunluk < EN_KISA:
                continue
            p = temiz[b:s + 1]
            # Ad: zincirdeki ilk adlı parça.
            ad = ref = ''
            for i in ids:
                a, r = adlar[i]
                ad = ad or a
                ref = ref or r
            orta = p[len(p) // 2]
            lats = [x[0] for x in p]
            lons = [x[1] for x in p]
            sonuc.append({
                'i': f'{min(ids)}' + (f'-{k}' if k else ''),
                'a': ad,
                'r': ref,
                'y': '' if ad else koyler.en_yakin(orta[0], orta[1]),
                's': sehirler.en_yakin(orta[0], orta[1]),
                'k': round(puan),
                'u': round(uzunluk),
                'c': sinif,
                'm': [round(orta[0], 4), round(orta[1], 4)],
                'b': [round(min(lats), 4), round(min(lons), 4),
                      round(max(lats), 4), round(max(lons), 4)],
                'p': kodla(sadelestir(p)),
            })
    sonuc.sort(key=lambda x: -x['k'])
    return sonuc[:EN_FAZLA_YOL]


def main():
    yollar_pbf, yerler_pbf, cikti = sys.argv[1:4]
    yollar, sehirler, koyler = oku(yollar_pbf, yerler_pbf)
    print(f'{len(yollar)} yol parçası okundu', flush=True)
    sonuc = hesapla(yollar, sehirler, koyler)
    veri = {'t': date.today().isoformat(), 'surum': 1, 'yollar': sonuc}
    with gzip.open(cikti, 'wt', encoding='utf-8') as f:
        json.dump(veri, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(sonuc)} virajlı yol yazıldı', flush=True)
    seviyeler = [sum(1 for x in sonuc if lo <= x['k'] < hi)
                 for lo, hi in ((500, 1000), (1000, 2000), (2000, 10**9))]
    print(f'Virajlı: {seviyeler[0]}, çok virajlı: {seviyeler[1]}, aşırı virajlı: {seviyeler[2]}')


if __name__ == '__main__':
    main()
