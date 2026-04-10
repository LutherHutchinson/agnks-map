
import json

file_path = 'stations.json'
with open(file_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

# Find Morshansk station (id: 28462)
found = False
for feature in data:
    if feature.get('id') == 28462:
        found = True
        # Update balloonContentBody
        new_body = (
            '<p>Тамбовская обл, г.Моршанск, ул.Садовая, д.1<br /> '
            'ООО "Моршанскметанавто"<br /> '
            '+7 (47533) 44-176<br /> '
            'пн-пт: 5ч30м - 11ч00м; 12ч00м-13ч00м; 14ч00м-15ч00м; 17ч00м-22ч00м<br />'
            'сб-вс: 5ч30м - 11ч00м<br /></p>'
            '<p><a target="_blank" href="/agnks_map/68/morshansk/">подробнее</a></p>'
        )
        feature['properties']['balloonContentBody'] = new_body
        break

if found:
    with open(file_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print("Success: Morshansk station updated.")
else:
    print("Error: Morshansk station not found.")
