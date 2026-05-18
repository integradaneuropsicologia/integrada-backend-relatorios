/*
1) Em preencher-avaliacao.html, adicione esta constante logo abaixo da SUPABASE_ANON_KEY:

const BACKEND_URL = "https://SEU-BACKEND-DO-RENDER.onrender.com";

2) Depois da função renderAnswers(), cole esta função:
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

/*
3) Substitua a função enviarRespostas(e) inteira por esta versão:
*/

async function enviarRespostas(e){
  e.preventDefault();

  const answers = questions.map(q=>{
    let value = "";

    if(q.question_type === "radio"){
      const selected = document.querySelector(`input[name="q_${q.id}"]:checked`);
      value = selected ? selected.value : "";
    }else if(q.question_type === "checkbox"){
      const selected = [...document.querySelectorAll(`input[name="q_${q.id}"]:checked`)];
      value = selected.map(i => i.value).join(", ");
    }else{
      value = $(`q_${q.id}`)?.value || "";
    }

    return {
      question_id: q.id,
      question_text: q.question_text,
      value
    };
  });

  const { error } = await sb.rpc("submit_public_assessment_with_session", {
    p_token: token,
    p_session_token: sessionToken,
    p_answers: answers
  });

  if(error){
    showMessage(error.message || "Erro ao enviar avaliação.");
    return;
  }

  $("form").style.display = "none";
  showMessage("Avaliação enviada. Gerando relatório automático para a clínica...");

  try{
    await gerarRelatorioAutomatico();
    showMessage("Avaliação enviada com sucesso. O relatório foi encaminhado para a clínica.");
  }catch(err){
    console.error(err);
    showMessage("Avaliação enviada com sucesso. Mas houve erro ao gerar/enviar o relatório automático. Avise a clínica.");
  }
}
