# Используем официальный легкий образ Python
FROM python:3.9-slim

# Устанавливаем системные зависимости для psycopg2 и других библиотек
RUN apt-get update && apt-get install -y \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY requirements.txt .

# Устанавливаем зависимости Python
RUN pip install --no-cache-dir -r requirements.txt

# Копируем все остальные файлы проекта
COPY . .

# Открываем порт (Render будет использовать переменную среды PORT)
EXPOSE 8080

# Запускаем сервер
CMD ["python", "server.py"]
