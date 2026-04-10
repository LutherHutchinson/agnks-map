
import datetime
import re

def get_station_status(schedule_clean, station_time):
    abs_mins = station_time.hour * 60 + station_time.minute
    
    schedule = schedule_clean.lower() if schedule_clean else ""
    if not schedule: return "no_data"
    
    is_always = bool(re.search(r"круглосуточно|24\s*/?\s*7|24\s*[чh]", schedule, re.I))
    
    # NEW REFINED REGEX from app.js
    simple_regex = r"\b(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\s*(?:-|—|–|−|\s+(?:до|по)\s+)\s*(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\b"
    matches = re.finditer(simple_regex, schedule)
    
    working_intervals = []
    time_found = False
    for m in matches:
        sh = int(m.group(1))
        sm = int(m.group(2) or m.group(3) or m.group(4) or 0)
        eh = int(m.group(5))
        em = int(m.group(6) or m.group(7) or m.group(8) or 0)
        if sh > 24 or sm > 59 or eh > 24 or em > 59: continue
        if sh == eh and sm == em: continue
        time_found = True
        working_intervals.append({"start": sh*60 + sm, "end": eh*60 + em})
                
    print(f"Schedule: {schedule}")
    print(f"Working Intervals: {working_intervals}")
    
    if working_intervals:
        for w in working_intervals:
            if w["end"] > w["start"]:
                if abs_mins >= w["start"] and abs_mins < w["end"]: return "open"
            else:
                if abs_mins >= w["start"] or abs_mins < w["end"]: return "open"
        return "closed"
    
    if is_always: return "open"
    return "no_data"

# Test Case: Peschan-Koledino
now = datetime.datetime(2026, 4, 5, 1, 18) # 01:18 AM UTC+3
offset = 5 # Ekaterinburg (+5)
station_time = now + datetime.timedelta(hours=offset - 3) # offset relative to local time?
# Wait, let's just set the station time directly as it would be at 01:18 AM local time (MSK).
# MSK is UTC+3. Station is UTC+5. So station is 2 hours ahead of MSK.
# If MSK is 01:18, Station is 03:18.
station_time = now + datetime.timedelta(hours=2)

print("--- TEST: Песчано-Коледино (8 00 - 20 00) ---")
print(f"Local Time (MSK): {now.strftime('%H:%M')}")
print(f"Station Time: {station_time.strftime('%H:%M')}")
print("Expected: closed (since 03:18 < 08:00)")
print("Result:", get_station_status("с 8 00 - 20 00 без выходных", station_time))

print("\n--- TEST: Карталы (Phone 6-72-64) ---")
# The issue here was the selection of the line. 
# scheduleRegex = \b\d{1,2}[:. ][0-5]\d\b
line = "т. (35133) 6-72-64"
phone_regex = r"(\+7|8\s*[\(\-]?\d{3}|\bтел\b|\bт\.\s*\(|\bфакс\b)"
schedule_regex = r"\b\d{1,2}[:. ][0-5]\d\b"

is_phone = bool(re.search(phone_regex, line, re.I))
is_schedule = bool(re.search(schedule_regex, line, re.I))

print(f"Line: {line}")
print(f"Is Phone: {is_phone} (Expected: True)")
print(f"Is Schedule: {is_schedule} (Expected: False because 72 > 59)")
