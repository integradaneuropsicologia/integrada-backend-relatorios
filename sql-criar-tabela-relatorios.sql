create table if not exists public.assessment_ai_reports (
  id uuid primary key default gen_random_uuid(),
  candidate_assessment_id uuid not null references public.candidate_assessments(id) on delete cascade,
  report_text text not null,
  email_to text not null default 'integradaneuropsicologia@gmail.com',
  status text not null default 'sent',
  error_message text,
  created_at timestamptz default now()
);

create unique index if not exists assessment_ai_reports_candidate_assessment_id_uidx
on public.assessment_ai_reports(candidate_assessment_id);

alter table public.assessment_ai_reports enable row level security;

-- Mantém privado. O backend usa SERVICE_ROLE_KEY e consegue gravar mesmo com RLS.
-- Não crie política pública para esta tabela.
