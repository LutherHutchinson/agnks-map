import re

day_map = {
    'пн': [1], 'вт': [2], 'ср': [3], 'чт': [4], 'пт': [5], 'сб': [6], 'вс': [0],
    'будни': [1, 2, 3, 4, 5], 'выходн': [6, 0], 'ежедневно': [0, 1, 2, 3, 4, 5, 6]
}

def test_schedule(schedule_text, time_str, day_of_week):
    schedule = schedule_text.lower()
    
    # Simulation of current logic
    # schedule = schedule.replace("без выходных", "ежедневно") # Candidate FIX
    schedule = schedule.replace("выходных", "выходн")
    schedule = schedule.replace("выходные", "выходн")
    
    print(f"Testing: \"{schedule_text}\" at {time_str} (Day: {day_of_week})")
    print(f"Normalized: \"{schedule}\"")

    segments = re.split(r'[;\n]\s*', schedule)
    working_intervals = []
    has_any_work_day_data = False

    for seg in segments:
        if not seg.strip(): continue
        
        seg_days = []
        has_day_marker = False
        
        # Day tokens
        day_tokens = re.findall(r'[а-яё]+', seg)
        if day_tokens:
            for val in day_tokens:
                if val in day_map:
                    has_day_marker = True
                    seg_days.extend(day_map[val])

        if not has_day_marker:
            seg_days = [0, 1, 2, 3, 4, 5, 6]
            has_day_marker = True

        if day_of_week in seg_days:
            clean_seg = seg.strip()
            simple_regex = r'\b(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\s*(?:-|—|–|−|\s+(?:до|по)\s+)\s*(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\b'
            time_found = False
            
            for m in re.finditer(simple_regex, clean_seg):
                sh = int(m.group(1))
                sm = int(m.group(2) or m.group(3) or m.group(4) or '0')
                eh = int(m.group(5))
                em = int(m.group(6) or m.group(7) or m.group(8) or '0')
                if sh > 24 or sm > 59 or eh > 24 or em > 59: continue
                time_found = True
                working_intervals.append({'start': sh * 60 + sm, 'end': eh * 60 + em})

            if not time_found:
                time_regex = r'(?:с\s*)?(\d{1,2})(?:\s*[:.ч]\s*(\d{1,2}))?\s*(?:мин|м)?\s*(?:-|—|–|−|по|до|и)\s*(?:до\s*)?(\d{1,2})(?:\s*[:.ч]\s*(\d{1,2}))?\s*(?:мин|м)?'
                for m in re.finditer(time_regex, clean_seg):
                    startH = int(m.group(1))
                    startM = int(m.group(2)) if m.group(2) else 0
                    endH = int(m.group(3))
                    endM = int(m.group(4)) if m.group(4) else 0
                    if startH > 24 or startM > 59 or endH > 24 or endM > 59: continue
                    time_found = True
                    working_intervals.append({'start': startH * 60 + startM, 'end': endH * 60 + endM})

    h, m = map(int, time_str.split(':'))
    abs_mins = h * 60 + m
    
    is_open = False
    for w in working_intervals:
        if abs_mins >= w['start'] and abs_mins < w['end']:
            is_open = True
            break
            
    print(f"Result: {'OPEN' if is_open else 'CLOSED'} (Intervals: {working_intervals})")
    print('---')

# Current behavior (fails)
print("--- Current behavior ---")
test_schedule('с 8 00 - 20 00 без выходных', '13:48', 3)

# With FIX
def test_schedule_fixed(schedule_text, time_str, day_of_week):
    schedule = schedule_text.lower()
    
    # FIX:
    schedule = re.sub(r'без\s+выходных?', 'ежедневно', schedule)
    
    schedule = schedule.replace("выходных", "выходн")
    schedule = schedule.replace("выходные", "выходн")
    
    print(f"Testing Fixed: \"{schedule_text}\" at {time_str} (Day: {day_of_week})")
    print(f"Normalized: \"{schedule}\"")

    segments = re.split(r'[;\n]\s*', schedule)
    working_intervals = []

    for seg in segments:
        if not seg.strip(): continue
        seg_days = []
        has_day_marker = False
        day_tokens = re.findall(r'[а-яё]+', seg)
        if day_tokens:
            for val in day_tokens:
                if val in day_map:
                    has_day_marker = True
                    seg_days.extend(day_map[val])
        if not has_day_marker:
            seg_days = [0, 1, 2, 3, 4, 5, 6]
            has_day_marker = True

        if day_of_week in seg_days:
            simple_regex = r'\b(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\s*(?:-|—|–|−|\s+(?:до|по)\s+)\s*(\d{1,2})(?:[:](\d{2})|[.](\d{2})|[ ]([0-5]\d))?\b'
            for m in re.finditer(simple_regex, seg):
                sh = int(m.group(1))
                sm = int(m.group(2) or m.group(3) or m.group(4) or '0')
                eh = int(m.group(5))
                em = int(m.group(6) or m.group(7) or m.group(8) or '0')
                working_intervals.append({'start': sh * 60 + sm, 'end': eh * 60 + em})

    h, m = map(int, time_str.split(':'))
    abs_mins = h * 60 + m
    is_open = False
    for w in working_intervals:
        if abs_mins >= w['start'] and abs_mins < w['end']:
            is_open = True
            break
    print(f"Result: {'OPEN' if is_open else 'CLOSED'} (Intervals: {working_intervals})")
    print('---')

print("--- Fixed behavior ---")
test_schedule_fixed('с 8 00 - 20 00 без выходных', '13:48', 3)
