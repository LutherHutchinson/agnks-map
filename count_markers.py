import json

with open('gazprom_stations.json', 'r', encoding='utf-8') as f:
    gazprom_raw = json.load(f)
items_gazprom = gazprom_raw.get('elements', gazprom_raw)

with open('agnks_ru.json', 'r', encoding='utf-8') as f:
    items_agnks_ru = json.load(f)

with open('stations.json', 'r', encoding='utf-8') as f:
    items_all = json.load(f)

all_features = []
tolerance = 0.01

for el in items_gazprom:
    if el.get('gps'):
        try:
            coords = [float(x.strip()) for x in el['gps'].split(',')]
            if len(coords) == 2 and not (coords[0] == 0 and coords[1] == 0):
                all_features.append({'lat': coords[0], 'lon': coords[1]})
        except:
            pass

count_gazprom = len(all_features)

count_agnks = 0
filtered_out = 0
for el in items_agnks_ru:
    if 'lat' in el and 'lon' in el:
        status = el.get('status', '').lower()
        if 'строит' in status or 'планир' in status or 'проектир' in status:
            filtered_out += 1
            continue
            
        lat_new = float(el['lat'])
        lon_new = float(el['lon'])
        
        is_duplicate = any(abs(existing['lat'] - lat_new) < tolerance and abs(existing['lon'] - lon_new) < tolerance for existing in all_features)
        if not is_duplicate:
            all_features.append({'lat': lat_new, 'lon': lon_new})
            count_agnks += 1

count_primary = 0
for item in items_all:
    if item.get('type') == 'Feature' and 'geometry' in item and 'properties' in item:
        coords = item['geometry'].get('coordinates', [])
        if len(coords) == 2:
            lat_new, lon_new = float(coords[0]), float(coords[1])
            is_duplicate = any(abs(existing['lat'] - lat_new) < tolerance and abs(existing['lon'] - lon_new) < tolerance for existing in all_features)
            if not is_duplicate:
                all_features.append({'lat': lat_new, 'lon': lon_new})
                count_primary += 1

print(f"Газпром: {count_gazprom}")
print(f"agnks.ru (добавлено уникальных): {count_agnks} (всего в базе {len(items_agnks_ru)}, отфильтровано строящихся {filtered_out})")
print(f"stations.json (добавлено уникальных): {count_primary} (всего в базе {len(items_all)})")
print(f"\nИТОГО сейчас на карте: {len(all_features)} меток")
