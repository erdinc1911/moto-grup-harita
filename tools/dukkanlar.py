#!/usr/bin/env python3
"""Türkiye'deki motosiklet dükkânlarını Overture Maps yer verisinden çıkarır.

Overture'ın yer verisi (Meta, Microsoft, Foursquare...) CDLA Permissive 2.0 ve
Apache 2.0 lisanslıdır; ticari kullanıma açıktır, kaynak gösterilmesi yeterli.

Kullanım: dukkanlar.py <overture sürümü> dukkanlar.json.gz
Çıktı: {"t": tarih, "s": sürüm, "d": [[id, ad, enlem, boylam, kategori, tel, adres, web, marka], ...]}
kategori bit alanı: 1 satış, 2 servis, 4 yedek parça, 8 ekipman, 16 lastik, 32 kiralama
"""
import gzip
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import date

import duckdb

SATIS, SERVIS, PARCA, EKIPMAN, LASTIK, KIRALAMA = 1, 2, 4, 8, 16, 32

# Yalnızca motosiklet yapan markalar (Honda, Suzuki, BMW araba da yapar).
MOTOR_MARKALARI = [
    'yamaha', 'kawasaki', 'ktm', 'ducati', 'harley', 'bajaj', 'kuba', 'mondial', 'rks',
    'arora', 'cfmoto', 'cf moto', 'benelli', 'vespa', 'piaggio', 'triumph', 'aprilia',
    'kymco', 'sym ', 'zontes', 'voge', 'qj motor', 'husqvarna', 'royal enfield', 'tvs ',
    'hero ', 'motomorini', 'moto morini', 'mv agusta', 'peugeot motocycles', 'falcon',
    'yuki', 'kanuni', 'motolux', 'lifan', 'keeway', 'daelim', 'hyosung', 'gilera',
]
TUM_MARKALAR = [
    ('Honda', 'honda'), ('Yamaha', 'yamaha'), ('Kawasaki', 'kawasaki'), ('Suzuki', 'suzuki'),
    ('BMW', 'bmw'), ('KTM', 'ktm'), ('Ducati', 'ducati'), ('Harley-Davidson', 'harley'),
    ('Bajaj', 'bajaj'), ('Kuba', 'kuba'), ('Mondial', 'mondial'), ('RKS', 'rks'),
    ('Arora', 'arora'), ('CFMoto', 'cfmoto'), ('CFMoto', 'cf moto'), ('Benelli', 'benelli'),
    ('Vespa', 'vespa'), ('Piaggio', 'piaggio'), ('Triumph', 'triumph'), ('Aprilia', 'aprilia'),
    ('Kymco', 'kymco'), ('SYM', 'sym '), ('Zontes', 'zontes'), ('Voge', 'voge'),
    ('QJ Motor', 'qj motor'), ('Husqvarna', 'husqvarna'), ('Royal Enfield', 'royal enfield'),
    ('TVS', 'tvs '), ('Hero', 'hero '), ('Moto Morini', 'morini'), ('MV Agusta', 'mv agusta'),
    ('Falcon', 'falcon'), ('Yuki', 'yuki'), ('Kanuni', 'kanuni'), ('Hyosung', 'hyosung'),
    ('Keeway', 'keeway'), ('Lifan', 'lifan'), ('Gilera', 'gilera'),
]

MOTO_KATEGORI = re.compile(r'motorcycle|motorbike|motor_?scooter|moped|scooter')
# Dükkân olmayanlar: dernekler, kulüpler, sürücü kursları, araba kiralama, tekne.
DISLA = re.compile(r'dernek|kulüb|kulub|\bclub\b|riders|federasyon|sürücü|surucu|rent a car|rentacar|oto kuaför|yacht|tekne|\bmarin')
MOTO_AD = re.compile(r'motosiklet|motorsiklet|motorcycle|motobike|motorbike|scooter|\bmoto\b|moto[\s-]')


def turk(s):
    return (s or '').replace('İ', 'i').replace('I', 'ı').lower()


def kategoriler(kat_metin, ad):
    k = 0
    if re.search(r'dealer|dealership|motorcycle_shop|motorcycle_store|motorcycle_sales', kat_metin):
        k |= SATIS
    if re.search(r'repair|service|mechanic|maintenance', kat_metin):
        k |= SERVIS
    if re.search(r'parts|spare', kat_metin):
        k |= PARCA
    if re.search(r'gear|apparel|clothing|helmet|accessor', kat_metin):
        k |= EKIPMAN
    if re.search(r'tire|tyre', kat_metin):
        k |= LASTIK
    if re.search(r'rental|rent', kat_metin):
        k |= KIRALAMA
    if re.search(r'servis|tamir|bakım|bakim|onarım|tamirhane|usta', ad):
        k |= SERVIS
    if re.search(r'yedek parça|yedek parca|parça|parca', ad):
        k |= PARCA
    if re.search(r'kask|ekipman|aksesuar|giyim|outfit', ad):
        k |= EKIPMAN
    if re.search(r'lastik', ad):
        k |= LASTIK
    if re.search(r'kiralama|rent', ad):
        k |= KIRALAMA
    if re.search(r'bayi|satış|satis|galeri|plaza|store|mağaza|magaza', ad):
        k |= SATIS
    return k or SATIS


def marka_bul(ad, brand):
    if brand:
        return brand[:30]
    for gorunen, aranan in TUM_MARKALAR:
        if aranan in ad + ' ':
            return gorunen
    return ''


def main():
    surum, cikti = sys.argv[1], sys.argv[2]
    kaynak = f's3://overturemaps-us-west-2/release/{surum}/theme=places/type=place/*'
    db = duckdb.connect()
    db.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    sutunlar = {r[0]: r[1] for r in db.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{kaynak}') LIMIT 0").fetchall()}
    print('Sütunlar:', ', '.join(f'{k}' for k in sutunlar))

    kat_parcalari = [f'CAST({s} AS VARCHAR)' for s in ('categories', 'basic_category', 'taxonomy')
                     if s in sutunlar]
    kat_ifade = f"lower(concat_ws(' ', {', '.join(kat_parcalari)}))" if kat_parcalari else "''"
    secilen = [
        'id', 'names.primary AS ad', 'bbox.xmin AS lng', 'bbox.ymin AS lat',
        f'{kat_ifade} AS kat',
        "CAST(phones AS VARCHAR) AS tel" if 'phones' in sutunlar else "'' AS tel",
        "CAST(websites AS VARCHAR) AS web" if 'websites' in sutunlar else "'' AS web",
        "to_json(addresses) AS adres" if 'addresses' in sutunlar else "NULL AS adres",
        "brand.names.primary AS marka" if 'brand' in sutunlar else "NULL AS marka",
        "confidence AS guven" if 'confidence' in sutunlar else "1.0 AS guven",
        "CAST(operating_status AS VARCHAR) AS durum" if 'operating_status' in sutunlar else "'' AS durum",
    ]
    sorgu = f"""
        SELECT {', '.join(secilen)}
        FROM read_parquet('{kaynak}', hive_partitioning=1)
        WHERE bbox.xmin BETWEEN 25.6 AND 44.9 AND bbox.ymin BETWEEN 35.8 AND 42.2
          AND (regexp_matches({kat_ifade}, 'motorcycle|motorbike|scooter|moped')
               OR regexp_matches(lower(names.primary), 'moto|scooter|yamaha|kawasaki|ktm|ducati|harley|bajaj|kuba|mondial|vespa|piaggio|cfmoto|benelli|kymco|husqvarna|triumph|aprilia|zontes|voge'))
    """
    satirlar = db.execute(sorgu).fetchall()
    print(f'Aday: {len(satirlar)}')

    sayac = Counter()
    sonuc = []
    goruldu = set()
    for oid, ad, lng, lat, kat, tel, web, adres, marka, guven, durum in satirlar:
        if not ad or lat is None or lng is None:
            sayac['adsız'] += 1
            continue
        if durum and ('closed' in durum.lower()):
            sayac['kapalı'] += 1
            continue
        ulke = ''
        adres_metni = ''
        try:
            a = json.loads(adres) if adres else None
            if a:
                ulke = (a[0].get('country') or '').upper()
                parcalar = [a[0].get('freeform'), a[0].get('locality'), a[0].get('region')]
                adres_metni = ', '.join(p for p in parcalar if p)[:120]
        except (ValueError, AttributeError, IndexError, TypeError):
            pass
        if ulke and ulke != 'TR':
            sayac['yurt dışı'] += 1
            continue
        ad_k = turk(ad)
        kat = kat or ''
        if DISLA.search(ad_k):
            sayac['dükkân değil (dernek, kurs...)'] += 1
            continue
        moto_kat = bool(MOTO_KATEGORI.search(kat))
        moto_ad = bool(MOTO_AD.search(ad_k + ' ')) or any(m in ad_k + ' ' for m in MOTOR_MARKALARI)
        if not moto_kat:
            # Kategori motosiklet değilse ad motosiklet olmalı ve yer bir araç/dükkân yeri olmalı.
            if not moto_ad:
                sayac['motosiklet değil'] += 1
                continue
            if not re.search(r'auto|vehicle|car_|repair|dealer|shop|store|retail|parts|tire|rental|service', kat):
                sayac['ad uyuyor ama tür değil'] += 1
                continue
            if re.search(r'restaurant|cafe|hotel|bar|food|school|museum|club', kat):
                sayac['mekân/okul'] += 1
                continue
        if guven is not None and guven < 0.4:
            sayac['düşük güven'] += 1
            continue
        anahtar = (ad_k, round(lat, 3), round(lng, 3))
        if anahtar in goruldu:
            sayac['çift'] += 1
            continue
        goruldu.add(anahtar)
        tel_m = ''
        if tel:
            m = re.search(r'\+?[\d][\d\s()-]{6,}', tel)
            tel_m = m.group(0).strip() if m else ''
        web_m = ''
        if web:
            m = re.search(r'https?://[^\s\'",\]]+', web)
            web_m = m.group(0)[:120] if m else ''
        k = kategoriler(kat, ad_k)
        kisa = 'ov' + hashlib.sha1(str(oid).encode()).hexdigest()[:14]
        sonuc.append([kisa, ad.strip()[:60], round(lat, 6), round(lng, 6), k, tel_m[:24],
                      adres_metni, web_m, marka_bul(ad_k, marka)])
        sayac['alındı'] += 1
        for bit, isim in [(SATIS, 'satış'), (SERVIS, 'servis'), (PARCA, 'parça'),
                          (EKIPMAN, 'ekipman'), (LASTIK, 'lastik'), (KIRALAMA, 'kiralama')]:
            if k & bit:
                sayac['· ' + isim] += 1

    for k, v in sayac.most_common():
        print(f'{k}: {v}')
    print('Örnekler:')
    for s in sonuc[:40]:
        print('  ', s[1], '|', s[4], '|', s[8], '|', s[6][:40])
    with gzip.open(cikti, 'wt', encoding='utf-8') as f:
        json.dump({'t': date.today().isoformat(), 's': surum, 'd': sonuc}, f,
                  ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
