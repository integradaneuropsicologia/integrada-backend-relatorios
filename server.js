import fs from "fs";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";


dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

function requiredEnv(name){
  if(!process.env[name]){
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
  return process.env[name];
}

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const OPENAI_API_KEY = requiredEnv("OPENAI_API_KEY");

const EMAIL_TO = process.env.EMAIL_TO || "integradaneuropsicologia@gmail.com";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const CLINIC_NAME = "Integrada Neuropsicologia";
const CLINIC_ADDRESS = "Rua Jacarezinho, 1266, Mercês. Curitiba/PR";
const CLINIC_PHONE = "(41) 99211-3665";
const CLINIC_EMAIL = "integradaneuropsicologia@gmail.com";

const RESPONSAVEL_TECNICA = "Carla Luciana da Conceição Lima";
const RESPONSAVEL_CRP = "CRP/PR 08-39739";

// Coloque sua logo dentro da pasta assets no backend:
// backend/assets/logo.png
const CLINIC_LOGO_PATH = process.env.CLINIC_LOGO_PATH || "./assets/logo.png";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const allowedOrigins = String(process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback){
    if(!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)){
      return callback(null, true);
    }
    return callback(new Error("Origem não permitida pelo CORS."));
  }
}));

app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "integrada-backend-relatorios" });
});

function onlyNumbers(value){
  return String(value || "").replace(/\D/g, "");
}

function safe(value, fallback = "-"){
  const text = String(value ?? "").trim();
  return text || fallback;
}

function sanitizeFilename(value){
  return String(value || "relatorio")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function getSingle(query, message){
  const { data, error } = await query.single();
  if(error) throw new Error(`${message}: ${error.message}`);
  return data;
}

async function getMaybeSingle(query){
  const { data, error } = await query.maybeSingle();
  if(error) throw error;
  return data;
}

function getAnswerValue(answers, questionId){
  const found = Array.isArray(answers)
    ? answers.find(item => String(item.question_id) === String(questionId))
    : null;

  return safe(found?.value, "Sem resposta registrada");
}

async function fetchAssessmentData(accessToken, sessionToken){
  const now = new Date().toISOString();

  const session = await getSingle(
    supabase
      .from("patient_sessions")
      .select("session_token, cpf, expires_at, revoked_at")
      .eq("session_token", sessionToken)
      .is("revoked_at", null)
      .gt("expires_at", now),
    "Sessão inválida ou expirada"
  );

  const assessment = await getSingle(
    supabase
      .from("candidate_assessments")
      .select("id, candidate_id, assessment_model_id, access_token, status, released_at, started_at, completed_at, created_at")
      .eq("access_token", accessToken),
    "Avaliação não encontrada"
  );

  const candidate = await getSingle(
    supabase
      .from("candidates")
      .select("id, full_name, cpf, primary_document_number, birth_date, email, phone, cell_phone, profession, city, state")
      .eq("id", assessment.candidate_id),
    "Paciente não encontrado"
  );

  const sessionCpf = onlyNumbers(session.cpf);
  const candidateCpf = onlyNumbers(candidate.cpf || candidate.primary_document_number);

  if(candidateCpf && sessionCpf && candidateCpf !== sessionCpf){
    throw Object.assign(new Error("Sessão não pertence a este paciente."), { statusCode: 403 });
  }

  const model = await getSingle(
    supabase
      .from("assessment_models")
      .select("id, name, description")
      .eq("id", assessment.assessment_model_id),
    "Modelo de avaliação não encontrado"
  );

  const submittedAnswers = await getMaybeSingle(
    supabase
      .from("patient_assessment_answers")
      .select("candidate_assessment_id, answers, submitted_at")
      .eq("candidate_assessment_id", assessment.id)
  );

  if(!submittedAnswers?.answers?.length){
    throw new Error("As respostas ainda não foram encontradas no banco de dados.");
  }

  const { data: questions, error: questionsError } = await supabase
    .from("assessment_questions")
    .select("id, section, question_text, question_type, options, risk_weight, critical_alert, order_index")
    .eq("assessment_model_id", assessment.assessment_model_id)
    .eq("active", true)
    .order("order_index", { ascending: true });

  if(questionsError) throw new Error(`Erro ao buscar perguntas: ${questionsError.message}`);

  const respostasOrganizadas = (questions || []).map((q, index) => ({
    numero: index + 1,
    secao: q.section || "",
    pergunta: q.question_text,
    tipo: q.question_type,
    peso_risco: q.risk_weight || 0,
    alerta_critico: Boolean(q.critical_alert),
    resposta: getAnswerValue(submittedAnswers.answers, q.id)
  }));

  return {
    assessment,
    candidate,
    model,
    submittedAt: submittedAnswers.submitted_at,
    respostasOrganizadas
  };
}

async function gerarAnaliseComOpenAI(payload){

const developerPrompt = `
Você é um assistente técnico-clínico da Integrada Neuropsicologia, especializado em avaliação psicológica, avaliação psicossocial e análise de aptidão para função/cargo.

Sua tarefa é elaborar uma MINUTA DE LAUDO PSICOLÓGICO DE APTIDÃO com base exclusivamente nos dados do avaliando, na avaliação aplicada e nas respostas fornecidas.

IMPORTANTE:
- Não invente informações.
- Não use dados que não estejam no payload enviado.
- Não feche diagnóstico clínico definitivo.
- Não afirme que a pessoa “tem” transtorno.
- Use termos como “as respostas indicam”, “observa-se”, “há sinais compatíveis com”, “há indícios de”, “não foram observados indícios relevantes”.
- A decisão deve ser voltada à APTIDÃO OU INAPTIDÃO para o contexto avaliado, e não a diagnóstico psiquiátrico.
- O resultado deve ser obrigatoriamente apenas uma destas opções: APTO ou INAPTO.
- Não use a expressão “análise gerada por IA”.
- Não mencione que é um relatório automatizado.
- Não inclua percentis, escores técnicos ou tabelas, a menos que estejam explicitamente no payload e sejam indispensáveis.
- Use linguagem profissional, clara, objetiva e adequada para documento psicológico.
- O texto deve ser escrito em português do Brasil.
- Não use listas extensas. Prefira texto em parágrafos.

CRITÉRIO GERAL PARA RESULTADO:
- Indique APTO quando as respostas não apontarem sinais relevantes de risco psicológico, emocional, comportamental, cognitivo ou funcional que comprometam o exercício da atividade avaliada.
- Indique INAPTO quando houver sinais relevantes de risco, prejuízo funcional, instabilidade emocional importante, comportamento incompatível com a função, risco à segurança, baixa aderência a regras, impulsividade grave, sofrimento psíquico intenso ou qualquer fator que possa comprometer a atividade avaliada.
- Se as informações forem insuficientes para uma conclusão segura e houver respostas ausentes em pontos importantes, indique INAPTO para fins desta análise e explique que há necessidade de complementação avaliativa.

ESTRUTURA OBRIGATÓRIA DO TEXTO:

TÍTULO:
Laudo psicológico de aptidão para [nome da avaliação ou cargo/função avaliada]

IDENTIFICAÇÃO:
Apresente os dados disponíveis do avaliando:
Nome, documento, data de nascimento, e-mail, telefone, profissão, cidade/estado e avaliação aplicada. Se algum dado não estiver disponível, não invente.

BREVE RELATÓRIO:
Escreva uma síntese objetiva do contexto da avaliação, informando que a análise considera as respostas apresentadas no instrumento aplicado e sua relação com a atividade/cargo avaliado.

ANÁLISE PSICOLÓGICA:
Descreva os principais achados relevantes das respostas, destacando aspectos emocionais, comportamentais, cognitivos, sociais, funcionais e de risco quando existirem.
Evite transformar sintomas em diagnósticos.
A análise deve focar no impacto funcional para a atividade pretendida.

PONTOS DE ATENÇÃO:
Aponte fatores que merecem atenção profissional, especialmente se houver respostas críticas, incoerências, sinais de sofrimento emocional, impulsividade, risco, instabilidade, dificuldades de atenção, comportamento opositor, agressividade, uso de substâncias ou prejuízo funcional.

RESULTADO:
Escreva obrigatoriamente em uma linha separada:
Resultado: APTO
ou
Resultado: INAPTO

JUSTIFICATIVA DO RESULTADO:
Explique de forma breve e objetiva por que o resultado foi considerado apto ou inapto para o contexto avaliado.

RESPONSÁVEL TÉCNICA:
Carla Luciana da Conceição Lima
CRP/PR 08-39739
`;

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "developer",
        content: [{ type: "input_text", text: developerPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload, null, 2) }]
      }
    ],
    max_output_tokens: 4500
  });

  const text = response.output_text?.trim();

  if(!text){
    throw new Error("A OpenAI não retornou texto de relatório.");
  }

  return text;
}

function gerarPdfBuffer({ candidate, model, submittedAt, reportText, respostasOrganizadas }){
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(18).text("Integrada Neuropsicologia", { align: "center" });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10).text("Relatório auxiliar automatizado de avaliação", { align: "center" });
    doc.moveDown(1.2);

    doc.font("Helvetica-Bold").fontSize(12).text("Dados gerais");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10);
    doc.text(`Paciente: ${safe(candidate.full_name)}`);
    doc.text(`Documento/CPF: ${safe(candidate.primary_document_number || candidate.cpf)}`);
    doc.text(`E-mail: ${safe(candidate.email)}`);
    doc.text(`Telefone: ${safe(candidate.cell_phone || candidate.phone)}`);
    doc.text(`Avaliação: ${safe(model.name)}`);
    doc.text(`Data de envio: ${submittedAt ? new Date(submittedAt).toLocaleString("pt-BR") : "-"}`);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).text("Análise gerada por IA");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10);

    String(reportText).split("\n").forEach(line => {
      const trimmed = line.trim();
      if(!trimmed){
        doc.moveDown(0.5);
        return;
      }
      doc.text(trimmed, { align: "left", lineGap: 2 });
    });

    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(14).text("Respostas preenchidas", { align: "center" });
    doc.moveDown(1);

    respostasOrganizadas.forEach(item => {
      doc.font("Helvetica-Bold").fontSize(10).text(`${item.numero}. ${safe(item.pergunta)}`);
      if(item.secao){
        doc.font("Helvetica-Oblique").fontSize(9).text(`Seção: ${item.secao}`);
      }
      doc.font("Helvetica").fontSize(10).text(`Resposta: ${safe(item.resposta)}`);
      doc.moveDown(0.75);
    });

    const range = doc.bufferedPageRange();
    for(let i = range.start; i < range.start + range.count; i++){
      doc.switchToPage(i);
      doc.font("Helvetica").fontSize(8).text(
        `Página ${i + 1} de ${range.count}`,
        48,
        doc.page.height - 34,
        { align: "center", width: doc.page.width - 96 }
      );
    }

    doc.end();
  });
}

async function enviarEmailComPdf({ candidate, model, pdfBuffer }){
  const transporter = nodemailer.createTransport({
    host: requiredEnv("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: requiredEnv("SMTP_USER"),
      pass: requiredEnv("SMTP_PASS")
    }
  });

  const filename = `relatorio-${sanitizeFilename(candidate.full_name)}-${new Date().toISOString().slice(0,10)}.pdf`;

  await transporter.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || "Integrada Neuropsicologia"}" <${process.env.SMTP_USER}>`,
    to: EMAIL_TO,
    subject: `Relatório automático - ${safe(candidate.full_name)} - ${safe(model.name)}`,
    text: `Olá,\n\nSegue em anexo o relatório auxiliar automático da avaliação preenchida por ${safe(candidate.full_name)}.\n\nImportante: este relatório é auxiliar e precisa de revisão profissional.\n\nIntegrada Neuropsicologia`,
    attachments: [
      {
        filename,
        content: pdfBuffer,
        contentType: "application/pdf"
      }
    ]
  });
}

async function salvarRegistroRelatorio(candidateAssessmentId, reportText, status = "sent", errorMessage = null){
  const { error } = await supabase
    .from("assessment_ai_reports")
    .upsert({
      candidate_assessment_id: candidateAssessmentId,
      report_text: reportText,
      email_to: EMAIL_TO,
      status,
      error_message: errorMessage
    }, { onConflict: "candidate_assessment_id" });

  if(error){
    console.error("Erro ao salvar assessment_ai_reports:", error.message);
  }
}

app.post("/api/avaliacao/analisar", async (req, res) => {
  try{
    const { access_token, session_token, force } = req.body || {};

    if(!access_token || !session_token){
      return res.status(400).json({ ok: false, error: "access_token e session_token são obrigatórios." });
    }

    const data = await fetchAssessmentData(access_token, session_token);

    if(!force){
      const existing = await getMaybeSingle(
        supabase
          .from("assessment_ai_reports")
          .select("id, status, created_at")
          .eq("candidate_assessment_id", data.assessment.id)
          .eq("status", "sent")
      ).catch(() => null);

      if(existing){
        return res.json({ ok: true, already_sent: true, message: "Relatório já havia sido enviado." });
      }
    }

    const payload = {
      paciente: {
        nome: data.candidate.full_name,
        documento: data.candidate.primary_document_number || data.candidate.cpf,
        nascimento: data.candidate.birth_date,
        email: data.candidate.email,
        telefone: data.candidate.cell_phone || data.candidate.phone,
        profissao: data.candidate.profession,
        cidade: data.candidate.city,
        estado: data.candidate.state
      },
      avaliacao: {
        nome: data.model.name,
        descricao: data.model.description,
        status: data.assessment.status,
        enviado_em: data.submittedAt
      },
      respostas: data.respostasOrganizadas
    };

    const reportText = await gerarAnaliseComOpenAI(payload);
    const pdfBuffer = await gerarPdfBuffer({
      candidate: data.candidate,
      model: data.model,
      submittedAt: data.submittedAt,
      reportText,
      respostasOrganizadas: data.respostasOrganizadas
    });

    await enviarEmailComPdf({
      candidate: data.candidate,
      model: data.model,
      pdfBuffer
    });

    await salvarRegistroRelatorio(data.assessment.id, reportText, "sent", null);

    return res.json({ ok: true, message: "Relatório gerado e enviado por e-mail." });

  }catch(err){
    console.error(err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "Erro interno ao gerar relatório."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});
