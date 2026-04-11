-- Таблица для хранения заметок (комментариев)
create table if not exists comments (
  id uuid default gen_random_uuid() primary key,
  station_id text not null,
  text text not null,
  date text not null,
  created_at timestamp with time zone default now(),
  user_id uuid references auth.users,
  author_email text
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
  
-- Таблица для хранения избранных заправок
create table if not exists favorites (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  station_id text not null,
  created_at timestamp with time zone default now(),
  unique(user_id, station_id)
);

-- Индексы
create index if not exists favorites_user_id_idx on favorites (user_id);

-- Настройка безопасности (RLS)
alter table favorites enable row level security;

-- Пользователи могут управлять только своим избранным
create policy "Users can manage their own favorites"
  on favorites for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
  
-- Автоматическое подтверждение email при регистрации (если не отключено в консоли)
-- Это поможет пользователям сразу входить в систему
create or replace function public.handle_new_user_confirmation()
returns trigger as $$
begin
  update auth.users
  set email_confirmed_at = now(),
      confirmed_at = now(),
      last_sign_in_at = now()
  where id = new.id;
  return new;
end;
$$ language plpgsql security definer;

-- Триггер должен срабатывать после вставки в auth.users
-- Примечание: В некоторых версиях Supabase лучше использовать перехват события создания пользователя
-- Но в качестве шпаргалки для SQL-редактора этот код полезен:
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- CREATE TRIGGER on_auth_user_created
--   AFTER INSERT ON auth.users
--   FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_confirmation();

-- Таблица для хранения любимых маршрутов
create table if not exists saved_routes (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  name text not null,
  origin_name text,
  dest_name text,
  origin_coords double precision[] not null,
  dest_coords double precision[] not null,
  waypoints jsonb default '[]'::jsonb, -- Список ID станций или их данных
  created_at timestamp with time zone default now()
);

-- Индексы
create index if not exists saved_routes_user_id_idx on saved_routes (user_id);

-- Настройка безопасности (RLS)
alter table saved_routes enable row level security;

-- Пользователи могут управлять только своими маршрутами
create policy "Users can manage their own routes"
  on saved_routes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Таблица для жалоб на ошибки
create table if not exists error_reports (
  id uuid default gen_random_uuid() primary key,
  station_id text, -- Опционально, если жалоба из балуна
  error_type text not null,
  description text,
  user_id uuid references auth.users,
  author_email text,
  status text default 'pending', -- pending, fixed, rejected
  created_at timestamp with time zone default now()
);

-- Настройка безопасности (RLS)
alter table error_reports enable row level security;

-- Разрешаем анонимам отправлять отчеты
create policy "Allow anonymous insert error reports"
  on error_reports for insert
  with check (true);

-- Разрешаем чтение только админам (или через сервисную роль)
-- Для простоты в рамках этого проекта, если нужно модерировать через JS:
create policy "Allow public read status for their own reports"
  on error_reports for select
  using (auth.uid() = user_id);
