import urllib.request
import json
import xml.etree.ElementTree as ET
import re

KML_URL = "https://www.google.com/maps/d/kml?mid=1BvT3UVcpH8K3SIq5SbHYeEXZwMb_8pdy&forcekml=1"
OUTPUT_FILE = "agnks_ru.json"

def clean_cdata(text):
    if not text:
        return ""
    # Remove HTML tags if any (the CDATA usually has <br> or similar)
    return re.sub(r'<[^>]+>', ' ', text).strip()

def fetch_and_parse():
    print(f"Fetching KML data from {KML_URL}...")
    try:
        req = urllib.request.Request(
            KML_URL, 
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            kml_data = response.read()

        print("Parsing KML...")
        root = ET.fromstring(kml_data)
        
        # KML namespace
        ns = {'kml': 'http://www.opengis.net/kml/2.2'}
        
        stations = []
        
        # Find all Placemarks
        for placemark in root.findall('.//kml:Placemark', ns):
            station = {}
            
            # Extract coordinates
            point = placemark.find('.//kml:Point/kml:coordinates', ns)
            if point is not None and point.text:
                coords = point.text.strip().split(',')
                if len(coords) >= 2:
                    lon, lat = float(coords[0]), float(coords[1])
                    station['lon'] = lon
                    station['lat'] = lat
                else:
                    continue
            else:
                continue

            # Extract ExtendedData
            ext_data = placemark.find('.//kml:ExtendedData', ns)
            if ext_data is not None:
                for data in ext_data.findall('kml:Data', ns):
                    name = data.get('name')
                    val = data.find('kml:value', ns)
                    val_text = val.text.strip() if val is not None and val.text else ""
                    
                    if name == 'Адрес':
                        station['address'] = val_text
                    elif name == 'тип':
                        station['type'] = val_text
                    elif name == 'статус':
                        station['status'] = val_text
                    elif name == 'АГНКС, название':
                        station['brand'] = val_text
                    elif name == 'График работы:':
                        station['schedule'] = val_text
                    elif name == 'Телефон':
                        station['phone'] = val_text

            if not station.get('brand'):
                name_el = placemark.find('kml:name', ns)
                station['brand'] = name_el.text.strip() if name_el is not None and name_el.text else "АГНКС"

            # Check if this looks like a valid station (has coordinates)
            if 'lat' in station and 'lon' in station:
                stations.append(station)
                
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(stations, f, ensure_ascii=False, indent=2)
            
        print(f"Successfully extracted {len(stations)} stations to {OUTPUT_FILE}.")
        return True

    except Exception as e:
        print(f"Error fetching or parsing KML: {e}")
        return False

if __name__ == "__main__":
    fetch_and_parse()
