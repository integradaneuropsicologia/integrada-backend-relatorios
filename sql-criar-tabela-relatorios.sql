create table if not exists public.assessment_ai_reports (
  id uuid primary key default gen_random_uuid(),
  candidate_assessment_id uuid not null references public.candidate_assessments(id) on delete cascade,
  report_text text not null,
  email_to text not null default 'integradaneuropsicologia@gmail.com',
  status text not null default 'sent' check (status in ('sent', 'failed', 'draft')),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz
);

alter table public.assessment_ai_reports add column if not exists updated_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'assessment_ai_reports_status_check'
      and conrelid = 'public.assessment_ai_reports'::regclass
  ) then
    alter table public.assessment_ai_reports
      add constraint assessment_ai_reports_status_check
      check (status in ('sent', 'failed', 'draft'));
  end if;
end $$;

create unique index if not exists assessment_ai_reports_candidate_assessment_id_uidx
on public.assessment_ai_reports(candidate_assessment_id);

alter table public.assessment_ai_reports enable row level security;

-- Mantém privado. O backend usa SERVICE_ROLE_KEY e consegue gravar mesmo com RLS.
-- Não crie política pública para esta tabela.
