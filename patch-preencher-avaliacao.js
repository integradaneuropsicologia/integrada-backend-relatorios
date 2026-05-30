/*
  Referencia do contrato usado por preencher-avaliacao.html.

  O frontend atual ja le BACKEND_URL de config.js e chama este endpoint
  depois que submit_public_assessment_with_session grava as respostas em
  candidate_assessments.responses.
*/

async function gerarRelatorioAutomatico(){
  const response = await fetch(`${BACKEND_URL}/api/avaliacao/analisar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      session_token: sessionToken
    })
  });

  const result = await response.json().catch(() => ({}));

  if(!response.ok || !result.ok){
    throw new Error(result.error || "Erro ao gerar relatório automático.");
  }

  return result;
}
