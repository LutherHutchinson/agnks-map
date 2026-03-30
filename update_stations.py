import urllib.request
import json
import os

GAZPROM_API_URL = "https://gazprom-agnks.ru/get-all-map-data"
OUTPUT_FILE = "gazprom_stations.json"

def fetch_and_save():
    print(f"Fetching fresh data from {GAZPROM_API_URL}...")
    try:
        req = urllib.request.Request(
            GAZPROM_API_URL, 
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=1) as response:
            data = response.read().decode('utf-8')
            # Verify it's valid JSON
            json_data = json.loads(data)
            if 'elements' not in json_data:
                raise Exception("Response does not contain 'elements'")
                
            with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
                f.write(data)
            print(f"Successfully updated {OUTPUT_FILE} with {len(json_data['elements'])} stations.")
            return True
    except Exception as e:
        print(f"Error updating stations: {e}")
        return False

if __name__ == "__main__":
    fetch_and_save()
