-- Таблица для хранения заметок (комментариев)
create table if not exists comments (
  id uuid default gen_random_uuid() primary key,
  station_id text not null,
  text text not null,
  date text not null,
  created_at timestamp with time zone default now()
);

-- Индексы для быстрого поиска по ID заправки
create index if not exists comments_station_id_idx on comments (station_id);

-- Настройка безопасности (RLS)
alter table comments enable row level security;

-- Разрешаем всем читать заметки
create policy "Allow public read access"
  on comments for select
  using (true);

-- Разрешаем анонимам добавлять заметки
create policy "Allow anonymous insert access"
  on comments for insert
  with check (true);
