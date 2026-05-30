import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";


dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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
const CLINIC_LOGO_PATH = process.env.CLINIC_LOGO_PATH || path.join(__dirname, "assets", "logo.png");

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

function sha256(value){
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function safe(value, fallback = "-"){
  const text = String(value ?? "").trim();
  return text || fallback;
}

function formatDateOnly(value){
  if(!value) return "-";

  const parts = String(value).split("-");
  if(parts.length === 3){
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  return safe(value);
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

function normalizarTexto(value){
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function limparTextoRelatorio(text){
  return String(text || "")
    .split("\n")
    .filter(line => {
      const t = normalizarTexto(line).trim();

      if(t.includes("assistente tecnico")) return false;
      if(t.includes("assistente tecnico-clinico")) return false;
      if(t.includes("integrada neuropsicologia assistente")) return false;
      if(t === "integrada neuropsicologia") return false;
      if(t === "assistente tecnico") return false;
      if(t === "assistente tecnico-clinico") return false;

      return true;
    })
    .join("\n")
    .trim();
}

function identificarTipoFormulario(modelName = "", modelDescription = ""){
  const texto = normalizarTexto(`${modelName} ${modelDescription}`);

  const formulariosAptidao = [
    "avaliacao_individual_aptidao",
    "aptidao",
    "trabalho em altura",
    "nr35",
    "nr-35",
    "espaco confinado",
    "espaço confinado",
    "nr33",
    "nr-33",
    "inflamaveis",
    "inflamáveis",
    "combustiveis",
    "combustíveis",
    "nr20",
    "nr-20",
    "construcao reparacao naval",
    "construção reparação naval",
    "nr34",
    "nr-34",
    "plataformas petroleo",
    "plataformas petróleo",
    "offshore",
    "nr37",
    "nr-37",
    "funcoes criticas",
    "funções críticas",
    "pgr",
    "pcmso"
  ];

  const isAptidao = formulariosAptidao.some(item => texto.includes(normalizarTexto(item)));

  return isAptidao ? "aptidao_individual" : "risco_psicossocial_organizacional";
}

function obterTituloDocumento(model){
  const avaliacaoNome = safe(model.name);
  const tipoFormulario = identificarTipoFormulario(model.name, model.description);

  if(tipoFormulario === "aptidao_individual"){
    return `Laudo psicológico de aptidão para ${avaliacaoNome}`;
  }

  return `Relatório técnico de riscos psicossociais — ${avaliacaoNome}`;
}

function obterAssuntoEmail(candidate, model){
  const tipoFormulario = identificarTipoFormulario(model.name, model.description);

  if(tipoFormulario === "aptidao_individual"){
    return `Laudo psicológico de aptidão - ${safe(candidate.full_name)} - ${safe(model.name)}`;
  }

  return `Relatório técnico de riscos psicossociais - ${safe(candidate.full_name)} - ${safe(model.name)}`;
}

function obterTextoEmail(candidate, model){
  const tipoFormulario = identificarTipoFormulario(model.name, model.description);

  if(tipoFormulario === "aptidao_individual"){
    return `Olá,\n\nSegue em anexo o laudo psicológico de aptidão referente à avaliação preenchida por ${safe(candidate.full_name)}.\n\nAvaliação: ${safe(model.name)}\n\nResponsável técnica: Carla Luciana da Conceição Lima - CRP/PR 08-39739\n\nIntegrada Neuropsicologia`;
  }

  return `Olá,\n\nSegue em anexo o relatório técnico de riscos psicossociais referente à avaliação preenchida por ${safe(candidate.full_name)}.\n\nAvaliação: ${safe(model.name)}\n\nResponsável técnica: Carla Luciana da Conceição Lima - CRP/PR 08-39739\n\nIntegrada Neuropsicologia`;
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

  const assessment = await getSingle(
    supabase
      .from("candidate_assessments")
      .select("id, candidate_id, assessment_model_id, access_token, status, responses, released_at, submitted_at, completed_at, created_at")
      .eq("access_token", accessToken),
    "Avaliação não encontrada"
  );

  const candidate = await getSingle(
    supabase
      .from("candidates")
      .select("id, full_name, cpf, primary_document_number, birth_date, email, phone, cell_phone, profession, city, state, patient_session_token_hash, patient_session_expires_at")
      .eq("id", assessment.candidate_id),
    "Paciente não encontrado"
  );

  const sessionHash = sha256(sessionToken);
  const sessionExpiresAt = candidate.patient_session_expires_at
    ? new Date(candidate.patient_session_expires_at).toISOString()
    : null;

  if(!sessionToken || candidate.patient_session_token_hash !== sessionHash || !sessionExpiresAt || sessionExpiresAt <= now){
    throw Object.assign(new Error("Sessão não pertence a este paciente."), { statusCode: 403 });
  }

  const model = await getSingle(
    supabase
      .from("assessment_models")
      .select("id, name, description")
      .eq("id", assessment.assessment_model_id),
    "Modelo de avaliação não encontrado"
  );

  const submittedAnswers = Array.isArray(assessment.responses)
    ? assessment.responses
    : [];

  if(!submittedAnswers.length){
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
    resposta: getAnswerValue(submittedAnswers, q.id)
  }));

  delete candidate.patient_session_token_hash;
  delete candidate.patient_session_expires_at;

  return {
    assessment,
    candidate,
    model,
    submittedAt: assessment.submitted_at || assessment.completed_at,
    respostasOrganizadas
  };
}

async function gerarAnaliseComOpenAI(payload){

const developerPrompt = `
Atue internamente como especialista técnico em avaliação psicológica, avaliação psicossocial ocupacional, riscos psicossociais relacionados ao trabalho e análise de aptidão psicossocial para funções críticas.

Sua tarefa é elaborar um documento técnico com base exclusivamente no payload enviado.

NÃO invente informações.
NÃO use dados que não estejam no payload.
NÃO feche diagnóstico clínico definitivo.
NÃO afirme que a pessoa “tem” transtorno mental.
Use termos como “as respostas indicam”, “observa-se”, “há indícios”, “há sinais compatíveis com”, “não foram observados indícios relevantes”.
Não mencione que o texto foi gerado por IA.
Não mencione automação.
NÃO assine o documento.
NÃO escreva “Integrada Neuropsicologia assistente técnico”.
NÃO escreva “assistente técnico-clínico”.
NÃO inclua nome da clínica como assinatura no final do texto.
NÃO inclua rodapé, carimbo, local, data ou assinatura profissional no texto gerado.
Finalize o documento exclusivamente na seção CONCLUSÃO.
Escreva em português do Brasil.
Use linguagem profissional, clara, objetiva e adequada para documento psicológico/ocupacional.

O payload contém:
- dados do avaliando;
- dados da avaliação aplicada;
- tipo_formulario;
- respostas organizadas por seção;
- peso de risco;
- alerta crítico.

REGRA PRINCIPAL:

Se avaliacao.tipo_formulario for "risco_psicossocial_organizacional":
Elabore um RELATÓRIO TÉCNICO DE ANÁLISE DE RISCOS PSICOSSOCIAIS RELACIONADOS AO TRABALHO.
Não use APTO ou INAPTO.
O resultado deve ser uma classificação de risco:
BAIXO, MODERADO, ELEVADO ou CRÍTICO.

Se avaliacao.tipo_formulario for "aptidao_individual":
Elabore uma MINUTA DE LAUDO/RELATÓRIO PSICOLÓGICO DE APTIDÃO PSICOSSOCIAL PARA FUNÇÃO CRÍTICA.
O resultado deve ser obrigatoriamente:
Resultado: APTO
ou
Resultado: INAPTO.

IMPORTANTE SOBRE INTERPRETAÇÃO DAS RESPOSTAS:

Nem toda resposta "Frequentemente" ou "Quase sempre" representa risco.
Analise o sentido da pergunta.

Em perguntas negativas, como "Sinto medo intenso", "Tenho dificuldade", "Já cometi erros", "Sinto pressão", "Tenho medo", respostas frequentes indicam maior risco.

Em perguntas protetivas, como "Consigo manter calma", "Consigo seguir comandos", "Tenho clareza dos riscos", "A empresa respeita a interrupção da atividade", respostas frequentes indicam fator favorável.

Alertas críticos só devem ser considerados críticos quando a resposta estiver no sentido de risco. Não trate automaticamente todo item com critical_alert como problema.

CRITÉRIOS PARA RELATÓRIO DE RISCO PSICOSSOCIAL ORGANIZACIONAL:

Classifique como BAIXO quando houver baixa frequência de fatores de risco, poucos alertas críticos e ausência de relatos relevantes de adoecimento, violência, assédio, sobrecarga grave, insegurança ou falhas organizacionais importantes.

Classifique como MODERADO quando houver sinais intermediários de sobrecarga, conflitos, falhas de comunicação, pressão, baixa autonomia, desgaste emocional ou condições organizacionais que exigem intervenção preventiva.

Classifique como ELEVADO quando houver concentração de respostas em frequência alta nas seções críticas, como sobrecarga, pressão por produtividade, violência, assédio, falhas de liderança, ausência de pausas, medo de relatar problemas, riscos à segurança ou sinais de adoecimento coletivo.

Classifique como CRÍTICO quando houver presença recorrente de assédio, ameaça, violência, medo de retaliação, afastamentos, rotatividade, adoecimento coletivo, risco operacional, pressão para trabalhar em condição insegura, ideação suicida relatada, uso de substâncias com impacto funcional ou falhas organizacionais graves sem suporte institucional.

ESTRUTURA PARA RELATÓRIO DE RISCO PSICOSSOCIAL ORGANIZACIONAL:

IDENTIFICAÇÃO:
Apresente os dados disponíveis do avaliando/respondente e a avaliação aplicada. Se algum dado não estiver disponível, não invente.

OBJETIVO DA AVALIAÇÃO:
Explique que o objetivo é analisar fatores de risco psicossocial relacionados ao trabalho, conforme o formulário aplicado, considerando percepção do trabalhador, organização do trabalho, condições psicossociais, sinais de adoecimento e fatores de proteção.

CARACTERIZAÇÃO DO CONTEXTO AVALIADO:
Descreva brevemente o tipo de setor, atividade ou grupo avaliado com base no nome e descrição da avaliação.

ANÁLISE DOS FATORES DE RISCO:
Organize a análise por seções do formulário. Destaque apenas os achados relevantes. Integre respostas fechadas e abertas. Aponte fatores como sobrecarga, pressão por metas, ritmo de trabalho, violência, assédio, conflitos, falhas de liderança, falta de suporte, baixa autonomia, fadiga, sono, trabalho isolado, exposição emocional, insegurança, falhas de comunicação e sinais de adoecimento.

FATORES DE PROTEÇÃO:
Aponte aspectos positivos quando existirem, como boa comunicação, clareza de procedimentos, apoio da liderança, autonomia, pausas adequadas, cooperação, segurança psicológica e percepção favorável de preparo.

ALERTAS CRÍTICOS:
Liste de forma objetiva os alertas críticos relevantes identificados. Se não houver alertas críticos relevantes, informe isso.

CLASSIFICAÇÃO DO RISCO:
Escreva obrigatoriamente em uma linha separada:
Classificação do risco psicossocial: BAIXO
ou
Classificação do risco psicossocial: MODERADO
ou
Classificação do risco psicossocial: ELEVADO
ou
Classificação do risco psicossocial: CRÍTICO

JUSTIFICATIVA DA CLASSIFICAÇÃO:
Explique de forma objetiva por que essa classificação foi atribuída.

RECOMENDAÇÕES TÉCNICAS:
Apresente recomendações práticas e proporcionais ao risco identificado. Inclua ações como revisão de carga de trabalho, melhoria de pausas, treinamento de liderança, protocolo contra violência/assédio, canal seguro de denúncia, revisão de metas, suporte psicológico, adequação de equipe, melhoria de comunicação, revisão de processos e monitoramento periódico.

CONCLUSÃO:
Finalize com síntese técnica, deixando claro que a análise se baseia nas respostas fornecidas e deve ser integrada a outros dados ocupacionais quando disponíveis, como absenteísmo, afastamentos, rotatividade, denúncias, PGR, PCMSO, entrevistas, observação do trabalho e indicadores internos.

CRITÉRIOS PARA APTIDÃO INDIVIDUAL:

Indique APTO quando as respostas não apontarem sinais relevantes de risco psicológico, emocional, comportamental, cognitivo ou funcional que comprometam a segurança da atividade avaliada.

Indique INAPTO quando houver sinais relevantes de risco, como sofrimento emocional intenso, crise de ansiedade ou pânico, ideação suicida recente, impulsividade grave, baixa adesão a procedimentos, dificuldade importante de atenção, uso de álcool, substâncias ou medicações com impacto funcional, sono/fadiga incompatível com atividade crítica, incapacidade de seguir comandos, incapacidade de comunicar risco ou mal-estar, medo incapacitante, trauma ativo, pressão organizacional para atuar sem segurança ou histórico relevante de acidentes/quase acidentes associado a comportamento inseguro.

Se as informações forem insuficientes para conclusão segura e houver respostas ausentes em pontos essenciais, indique INAPTO para fins desta análise e informe a necessidade de complementação avaliativa.

ESTRUTURA PARA APTIDÃO INDIVIDUAL:

IDENTIFICAÇÃO:
Apresente os dados disponíveis do avaliando: nome, documento, data de nascimento, e-mail, telefone, profissão, cidade/estado e avaliação aplicada.

OBJETIVO DA AVALIAÇÃO:
Explique que a avaliação busca analisar indicadores psicossociais relacionados à segurança, atenção, regulação emocional, comportamento, adesão a procedimentos e condição atual para a atividade crítica avaliada.

BREVE RELATÓRIO:
Descreva o contexto da avaliação e a atividade/função crítica relacionada.

ANÁLISE PSICOLÓGICA:
Analise os principais achados das respostas, incluindo compreensão de risco, atenção e concentração, impulsividade, tomada de decisão, controle emocional, sono e fadiga, uso de substâncias/medicações, comunicação e obediência a comando, adesão a procedimentos, histórico de incidentes, pressão organizacional e condição emocional atual.

PONTOS DE ATENÇÃO:
Aponte fatores que merecem atenção profissional, principalmente alertas críticos, incoerências, sofrimento emocional, impulsividade, risco à segurança, baixa adesão a regras, uso de substâncias, fadiga, medo intenso, pânico, trauma ou prejuízo funcional.

RESULTADO:
Escreva obrigatoriamente em uma linha separada:
Resultado: APTO
ou
Resultado: INAPTO

JUSTIFICATIVA DO RESULTADO:
Explique objetivamente por que o resultado foi considerado apto ou inapto para o contexto avaliado.

RECOMENDAÇÕES:
Quando necessário, indique recomendações como entrevista complementar, reavaliação, encaminhamento médico/psicológico, reciclagem de treinamento, supervisão, ajuste de escala, estabilização emocional, melhora do sono, afastamento temporário da atividade crítica ou análise integrada com medicina ocupacional.

CONCLUSÃO:
Finalize deixando claro que a conclusão psicológica subsidia a tomada de decisão ocupacional e deve ser integrada ao contexto da função, exigências reais da atividade, documentos ocupacionais e avaliação médica quando aplicável.
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
    throw new Error("Não foi possível retornar o texto do relatório.");
  }

  return limparTextoRelatorio(text);
}


function gerarPdfBuffer({ candidate, model, submittedAt, reportText, respostasOrganizadas }){
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
margins: {
  top: 105,
  bottom: 110,
  left: 48,
  right: 48
},
      bufferPages: true
    });

    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const avaliacaoNome = safe(model.name);
    const tituloLaudo = obterTituloDocumento(model);

    // Conteúdo principal
    doc.font("Helvetica-Bold").fontSize(15).text(tituloLaudo, {
      align: "center"
    });

   doc.moveDown(0.8);

const tipoFormulario = identificarTipoFormulario(model.name, model.description);

doc.font("Helvetica-Bold").fontSize(12).text(
  tipoFormulario === "aptidao_individual" ? "Laudo psicológico" : "Relatório técnico"
);

doc.moveDown(0.5);
doc.font("Helvetica").fontSize(10);

    String(reportText).split("\n").forEach(line => {
      const trimmed = line.trim();

if(!trimmed){
  return;
}

      const upper = trimmed.toUpperCase();

const isHeading =
  upper === "IDENTIFICAÇÃO:" ||
  upper === "OBJETIVO DA AVALIAÇÃO:" ||
  upper === "CARACTERIZAÇÃO DO CONTEXTO AVALIADO:" ||
  upper === "BREVE RELATÓRIO:" ||
  upper === "ANÁLISE PSICOLÓGICA:" ||
  upper === "ANÁLISE DOS FATORES DE RISCO:" ||
  upper === "FATORES DE PROTEÇÃO:" ||
  upper === "ALERTAS CRÍTICOS:" ||
  upper === "PONTOS DE ATENÇÃO:" ||
  upper === "CLASSIFICAÇÃO DO RISCO:" ||
  upper === "RESULTADO:" ||
  upper === "JUSTIFICATIVA DA CLASSIFICAÇÃO:" ||
  upper === "JUSTIFICATIVA DO RESULTADO:" ||
  upper === "RECOMENDAÇÕES TÉCNICAS:" ||
  upper === "RECOMENDAÇÕES:" ||
  upper === "CONCLUSÃO:";

      const isResultado =
  upper.includes("RESULTADO: APTO") ||
  upper.includes("RESULTADO: INAPTO") ||
  upper.includes("CLASSIFICAÇÃO DO RISCO PSICOSSOCIAL: BAIXO") ||
  upper.includes("CLASSIFICAÇÃO DO RISCO PSICOSSOCIAL: MODERADO") ||
  upper.includes("CLASSIFICAÇÃO DO RISCO PSICOSSOCIAL: ELEVADO") ||
  upper.includes("CLASSIFICAÇÃO DO RISCO PSICOSSOCIAL: CRÍTICO");

      if(isHeading){
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").fontSize(11).text(trimmed, {
          align: "left"
        });
        doc.moveDown(0.2);
      } else if(isResultado){
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").fontSize(13).text(trimmed, {
          align: "left"
        });
        doc.moveDown(0.5);
        doc.font("Helvetica").fontSize(10);
      } else {
        doc.font("Helvetica").fontSize(10).text(trimmed, {
          align: "justify",
          lineGap: 3
        });
      }
    });

    doc.moveDown(1.5);

    doc.font("Helvetica-Bold").fontSize(11).text("Responsável técnica");
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(10).text(RESPONSAVEL_TECNICA);
    doc.text(RESPONSAVEL_CRP);



// Cabeçalho e rodapé em todas as páginas
const range = doc.bufferedPageRange();

for(let i = range.start; i < range.start + range.count; i++){
  doc.switchToPage(i);

  const pageNumber = i - range.start + 1;
  const pageCount = range.count;

  const oldX = doc.x;
  const oldY = doc.y;
  const oldBottomMargin = doc.page.margins.bottom;

  // Permite escrever o rodapé dentro da área inferior sem criar páginas extras
  doc.page.margins.bottom = 20;

  // Cabeçalho
  const logoExists = fs.existsSync(CLINIC_LOGO_PATH);

  if(logoExists){
    try{
      doc.image(CLINIC_LOGO_PATH, 48, 24, {
        fit: [120, 50]
      });
    }catch(error){
      doc.font("Helvetica-Bold").fontSize(12).text(CLINIC_NAME, 48, 32, {
        lineBreak: false
      });
    }
  } else {
    doc.font("Helvetica-Bold").fontSize(12).text(CLINIC_NAME, 48, 32, {
      lineBreak: false
    });
  }

  doc.font("Helvetica-Bold").fontSize(11).text(CLINIC_NAME, 180, 32, {
    align: "right",
    width: doc.page.width - 228,
    lineBreak: false
  });

  doc.moveTo(48, 85)
    .lineTo(doc.page.width - 48, 85)
    .stroke();

  // Rodapé
  const footerY = doc.page.height - 70;

  doc.moveTo(48, footerY - 8)
    .lineTo(doc.page.width - 48, footerY - 8)
    .stroke();

  doc.font("Helvetica").fontSize(8).text(
    `${CLINIC_ADDRESS} - Telefone ${CLINIC_PHONE} - e-mail: ${CLINIC_EMAIL}`,
    48,
    footerY,
    {
      align: "center",
      width: doc.page.width - 96,
      lineBreak: false
    }
  );

  doc.font("Helvetica").fontSize(8).text(
    `Página ${pageNumber} de ${pageCount}`,
    48,
    footerY + 14,
    {
      align: "center",
      width: doc.page.width - 96,
      lineBreak: false
    }
  );

  doc.page.margins.bottom = oldBottomMargin;
  doc.x = oldX;
  doc.y = oldY;
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
   subject: obterAssuntoEmail(candidate, model),

text: obterTextoEmail(candidate, model),
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
      error_message: errorMessage,
      updated_at: new Date().toISOString()
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
  tipo_formulario: identificarTipoFormulario(data.model.name, data.model.description),
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
