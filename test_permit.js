
const permitRegex = /по\s*пропускам|пропускной\s*режим|спецпропуск|сотрудников\s*комбината|по\s*договору|только\s*для\s*юрлиц|только\s*служебн[а-я]*/i;
const scheduleRegex = /\b\d{1,2}[:.][0-5]\d\b|\d{1,2}ч\d{2}м|ежедневн|будни|круглосуточно|(?<=[^а-яёА-ЯЁa-zA-Z0-9]|^)(пн|вт|ср|чт|пт|сб|вс|будни|выходн)(?=[^а-яёА-ЯЁa-zA-Z0-9]|$)|(?<=[^а-яёА-ЯЁa-zA-Z0-9]|^)(?:с|до)\s+\d{1,2}|суббот|воскрес|выходн|перерыв|режим работы|режим раб|принима|без перерыв|временно не работает|закрыт/iu;

function testParse(lines) {
    const addressLines = [], scheduleLines = [];
    for (const line of lines) {
        if (permitRegex.test(line)) {
            if (scheduleRegex.test(line) && line.includes('.')) {
                const parts = line.split(/[\.]\s+/);
                parts.forEach(p => {
                    if (permitRegex.test(p)) addressLines.push(p);
                    else if (scheduleRegex.test(p)) scheduleLines.push(p);
                    else addressLines.push(p);
                });
            } else {
                addressLines.push(line);
            }
        } else if (scheduleRegex.test(line)) {
            scheduleLines.push(line);
        } else {
            addressLines.push(line);
        }
    }
    console.log("Address:", addressLines);
    console.log("Schedule:", scheduleLines);
}

console.log("--- Test 1: Mixed line ---");
testParse(["по пропускам. будни: 8.00-12.00, 16.00-19.00; вс- не работает"]);

console.log("\n--- Test 2: Separate lines ---");
testParse(["Волгоградская обл", "по пропускам", "будни: 8:00-20:00"]);
