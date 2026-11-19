#!/usr/bin/env python3
"""OpenStreetMap'teki sabit hız kameralarını (highway=speed_camera) çıkarır.

Kullanım: kameralar.py kameralar.osm.pbf kameralar.json
Çıktı: {"t": tarih, "k": [[id, enlem, boylam, yön|null, hız|null], ...]}
Yön derece (0 = kuzey): kameranın denetlediği gidiş yönü, biliniyorsa.
"""
import json
import sys
from datetime import date

YONLER = {'N': 0, 'NNE': 22, 'NE': 45, 'ENE': 67, 'E': 90, 'ESE': 112, 'SE': 135, 'SSE': 157,
          'S': 180, 'SSW': 202, 'SW': 225, 'WSW': 247, 'W': 270, 'WNW': 292, 'NW': 315, 'NNW': 337}


def yon(deger):
    if not deger:
        return None
    d = deger.strip().upper()
    if d in YONLER:
        return YONLER[d]
    try:
        v = float(d.split(';')[0])
        return round(v % 360)
    except ValueError:
        return None  # forward/backward/both: yola göre, burada bilinmiyor


def hiz(deger):
    try:
        return int(''.join(c for c in (deger or '') if c.isdigit())[:3]) or None
    except ValueError:
        return None


def main():
    import osmium
    kayitlar = []

    class Okuyucu(osmium.SimpleHandler):
        def node(self, n):
            if n.tags.get('highway') != 'speed_camera' or not n.location.valid():
                return
            kayitlar.append([
                n.id,
                round(n.location.lat, 6),
                round(n.location.lon, 6),
                yon(n.tags.get('direction') or n.tags.get('camera:direction')),
                hiz(n.tags.get('maxspeed')),
            ])

    Okuyucu().apply_file(sys.argv[1])
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump({'t': date.today().isoformat(), 'k': kayitlar}, f, separators=(',', ':'))
    yonlu = sum(1 for k in kayitlar if k[3] is not None)
    print(f'{len(kayitlar)} kamera ({yonlu} tanesinin yönü belli)')


if __name__ == '__main__':
    main()
