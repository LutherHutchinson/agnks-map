import urllib.request
import json
import re

# Load config
try:
    with open('config.js', 'r', encoding='utf-8') as f:
        content = f.read()
        url_match = re.search(r"SUPABASE_URL:\s*'([^']+)'", content)
        key_match = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", content)
        SUPABASE_URL = url_match.group(1) if url_match else None
        SUPABASE_KEY = key_match.group(1) if key_match else None
except:
    SUPABASE_URL = None
    SUPABASE_KEY = None

TABLES = ['comments', 'favorites', 'saved_routes', 'error_reports']

def clean_table(table):
    print(f"Cleaning table {table}...")
    url = f"{SUPABASE_URL}/rest/v1/{table}?id=not.is.null"
    req = urllib.request.Request(
        url, 
        method='DELETE',
        headers={
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json'
        }
    )
    try:
        with urllib.request.urlopen(req) as response:
            if response.getcode() in [200, 204]:
                print(f"✅ {table} cleaned.")
    except Exception as e:
        print(f"❌ Error cleaning {table}: {e}")

if __name__ == "__main__":
    if SUPABASE_URL and SUPABASE_KEY:
        for table in TABLES:
            clean_table(table)
    else:
        print("Missing Supabase credentials")
