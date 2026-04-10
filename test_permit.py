import re

permit_regex = re.compile(r'по\s*пропускам|пропускной\s*режим|спецпропуск|сотрудников\s*комбината|по\s*договору|только\s*для\s*юрлиц|только\s*служебн[а-я]*', re.IGNORECASE)
schedule_regex = re.compile(r'\b\d{1,2}[:.][0-5]\d\b|\d{1,2}ч\d{2}м|ежедневн|будни|круглосуточно|(?:(?<=[^а-яёа-яёa-za-z0-9])|^)(пн|вт|ср|чт|пт|сб|вс|будни|выходн)(?=[^а-яёа-яёa-za-z0-9]|$)|(?:(?<=[^а-яёа-яёa-za-z0-9])|^)(?:с|до)\s+\d{1,2}|суббот|воскрес|выходн|перерыв|режим работы|режим раб|принима|без перерыв|временно не работает|закрыт', re.IGNORECASE | re.UNICODE)

def test_parse(lines):
    address_lines = []
    schedule_lines = []
    for line in lines:
        if permit_regex.search(line):
            if schedule_regex.search(line) and '.' in line:
                parts = re.split(r'[\.]\s+', line)
                for p in parts:
                    if permit_regex.search(p):
                        address_lines.append(p)
                    elif schedule_regex.search(p):
                        schedule_lines.append(p)
                    else:
                        address_lines.append(p)
            else:
                address_lines.append(line)
        elif schedule_regex.search(line):
            schedule_lines.append(line)
        else:
            address_lines.append(line)
    print("Address:", address_lines)
    print("Schedule:", schedule_lines)

print("--- Test 1: Mixed line ---")
test_parse(["по пропускам. будни: 8.00-12.00, 16.00-19.00; вс- не работает"])

print("\n--- Test 2: Separate lines ---")
test_parse(["Волгоградская обл", "по пропускам", "будни: 8:00-20:00"])
