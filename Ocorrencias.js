// ============================================================================
//  Coletor E193 — OCORRÊNCIAS DO MÊS (1º BBM)
//
//  Irmão do poa.js. O poa.js coleta a ESCALA; este coleta as OCORRÊNCIAS
//  FECHADAS, do relatório Relatórios › Mapa › Calor BBM.
//
//  Dado fechado = natureza confirmada pela guarnição depois do atendimento.
//  Não confundir com o /aodc/oc.php, que traz o que está em aberto agora,
//  ainda com a informação que veio pelo telefone.
//
//  Saída: dados/PAINEL_MES_ATUAL.csv, do dia 1 do mês até hoje.
//  O bloco de login é o mesmo do poa.js, que já é comprovado.
// ============================================================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER = process.env.E193_USER;
const PASS = process.env.E193_PASS;

const URL_BASE = 'https://e193.cbm.rs.gov.br/index.php';
const BBM = '1';                            // 1º BBM no seletor de batalhão
const SAIDA = 'dados/PAINEL_MES_ATUAL.csv';

// Identifica o robô como um Chrome comum (muitos sites recusam o "headless").
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (!USER || !PASS) {
  console.error('ERRO: faltam variáveis E193_USER ou E193_PASS.');
  process.exit(1);
}

const doisDig = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${doisDig(d.getMonth() + 1)}-${doisDig(d.getDate())}`;
const hoje = new Date();
const primeiroDoMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

async function salvarDiagnostico(page, motivo) {
  try {
    console.log('--- DIAGNÓSTICO (' + motivo + ') ---');
    console.log('URL atual :', page.url());
    console.log('Título    :', await page.title());
    const inputs = await page.$$eval('input', els =>
      els.map(e => e.name || e.id || e.type || '?'));
    console.log('Campos input encontrados:', JSON.stringify(inputs));
    const texto = await page.evaluate(() =>
      (document.body ? document.body.innerText : '').slice(0, 600));
    console.log('Texto visível (início):\n' + texto);
    await page.screenshot({ path: 'erro.png', fullPage: true }).catch(() => {});
    fs.writeFileSync('erro.html', await page.content().catch(() => ''));
    console.log('--- (foto e HTML salvos como erro.png / erro.html) ---');
  } catch (e) {
    console.log('Não consegui salvar o diagnóstico:', e.message);
  }
}

// Fecha os avisos e modais que o E193 abre depois do login e que travam a
// tela inteira. Mesmo bloco do poa.js — reaparecem, então é chamado de novo
// a cada tentativa de navegação.
async function fecharAvisos(page) {
  await page.evaluate(() => {
    try { if (typeof FecharSenha === 'function') FecharSenha(); } catch (e) {}
    try {
      if (window.jQuery) {
        jQuery('.b-close').trigger('click');
        jQuery('#popup, #aviso_deslocamento').hide();
      }
    } catch (e) {}
    document.querySelectorAll('.modal.show').forEach(m => {
      m.classList.remove('show'); m.style.display = 'none';
    });
    document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }).catch(() => {});
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    timezoneId: 'America/Sao_Paulo',
    locale: 'pt-BR',
    userAgent: UA,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    console.log('Abrindo o E193...');
    await page.goto(URL_BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    console.log('URL após abrir:', page.url(), '| Título:', await page.title());

    // ----- 1) LOGIN ---------------------------------------------------------
    // Idêntico ao poa.js: o campo de usuário se chama "login" (não "usuario"),
    // e o "Entrar" dispara a função startE193().
    try {
      await page.waitForSelector('#login', { timeout: 30000 });
    } catch (e) {
      await salvarDiagnostico(page, 'campo de login nao apareceu');
      throw e;
    }

    await page.fill('#login', USER);
    await page.fill('#senha', PASS);
    console.log('Fazendo login...');

    const acionou = await page.evaluate(() => {
      if (typeof startE193 === 'function') { startE193(); return true; }
      return false;
    }).catch(() => false);
    if (!acionou) {
      const btn = await page.$('button.btn-danger') || await page.$('button');
      if (btn) await btn.click();
    }

    try {
      await page.waitForFunction(
        () => !document.querySelector('#login') || document.querySelector('#main_navbar'),
        { timeout: 30000 }
      );
    } catch (e) {
      await salvarDiagnostico(page, 'login nao avancou (confira usuario/senha nos Secrets)');
      throw e;
    }
    await page.waitForTimeout(2500);
    await fecharAvisos(page);
    await page.waitForTimeout(1000);

    // ----- 2) NAVEGAR ATÉ O MAPA DE CALOR POR BBM --------------------------
    console.log('Navegando para o Mapa de Calor (filtro BBM)...');
    let chegou = false;
    for (let i = 0; i < 4 && !chegou; i++) {
      await fecharAvisos(page);
      await page.evaluate(() => {
        if (typeof loadModulo === 'function') {
          loadModulo('rel', '81', 'relatorios/mapa_calor/mapa_calor_bbm.php');
        }
      }).catch(() => {});
      chegou = await page.waitForSelector('#frm_param #dt_inicial', { timeout: 20000 })
        .then(() => true).catch(() => false);
    }
    if (!chegou) {
      await salvarDiagnostico(page, 'nao cheguei na tela do Mapa de Calor (pode ser permissao do perfil)');
      throw new Error('Nao cheguei na tela do Mapa de Calor');
    }
    await page.waitForTimeout(1500);

    // ----- 3) FILTRAR ------------------------------------------------------
    // Mesma armadilha que o poa.js encontrou na cidade: o seletor de BBM é um
    // dropdown do Semantic UI, onde o rótulo aparece na parte visível mas o
    // VALOR fica num input escondido — que no robô vem vazio. Então avisamos o
    // componente e, por garantia, gravamos o valor direto no input.
    console.log(`Filtrando 1º BBM de ${iso(primeiroDoMes)} até ${iso(hoje)}...`);
    await page.fill('#frm_param #dt_inicial', iso(primeiroDoMes));
    await page.fill('#frm_param #dt_final', iso(hoje));

    await page.evaluate((bbm) => {
      try {
        const $sel = window.jQuery('.ui.dropdown.nr_batalhao');
        if ($sel.length && $sel.dropdown) $sel.dropdown('set exactly', [bbm]);
      } catch (e) {}
      const c = document.getElementById('nr_batalhao');
      if (c && !c.value) c.value = bbm;   // rede de segurança
    }, BBM);

    const filtro = await page.evaluate(() => ({
      rotulos: [...document.querySelectorAll('.nr_batalhao a.ui.label')].map(a => a.textContent.trim()),
      valor: (document.getElementById('nr_batalhao') || {}).value || ''
    }));
    console.log('Filtro BBM — rótulos:', JSON.stringify(filtro.rotulos), '| valor:', JSON.stringify(filtro.valor));
    if (!filtro.rotulos.length && !filtro.valor) {
      await salvarDiagnostico(page, 'o filtro de BBM ficou vazio');
      throw new Error('Filtro de BBM vazio');
    }

    // ----- 4) CONSULTAR E ESPERAR A TABELA ---------------------------------
    console.log('Consultando...');
    await page.evaluate(() => {
      if (typeof ConsultarRel === 'function') ConsultarRel(3);
    });

    try {
      await page.waitForFunction(() => {
        const $ = window.jQuery;
        if (!$ || !$.fn.dataTable || !$('#oc_table').length) return false;
        if (!$.fn.dataTable.isDataTable('#oc_table')) return false;
        return $('#oc_table').DataTable().rows().count() > 0;
      }, { timeout: 180000 });   // mês inteiro demora
    } catch (e) {
      await salvarDiagnostico(page, 'a consulta nao devolveu tabela');
      throw e;
    }
    await page.waitForTimeout(1500);

    // ----- 5) EXTRAIR ------------------------------------------------------
    // O DataTables guarda TODAS as linhas do lado do navegador, então
    // rows().data() traz o conjunto inteiro sem precisar paginar de 10 em 10.
    console.log('Extraindo dados...');
    const linhas = await page.evaluate(() => {
      const dt = window.jQuery('#oc_table').DataTable();
      const limpar = html => {
        const d = document.createElement('div');
        d.innerHTML = html == null ? '' : html;
        return (d.textContent || '').replace(/\s+/g, ' ').trim();
      };
      return dt.rows().data().toArray()
        .map(l => (Array.isArray(l) ? l : Object.values(l)).map(limpar))
        .map(c => c.slice(0, 6));   // a 7ª coluna é o botão "Detalhar"
    });

    const info = await page.textContent('#oc_table_info').catch(() => '') || '';
    console.log(`Tabela: ${linhas.length} linhas. Rodapé do E193: ${info.trim()}`);

    // Nunca substituir um arquivo bom por um vazio. Sessão expirada ou filtro
    // perdido devolvem tabela vazia; zerar o painel da sala seria pior do que
    // manter o arquivo de ontem.
    if (!linhas.length) {
      await salvarDiagnostico(page, 'tabela carregou mas nao extraiu dados');
      throw new Error('Nenhum dado extraído — arquivo anterior mantido');
    }

    // ----- 6) GRAVAR O CSV -------------------------------------------------
    const cabecalho = ['Nº Oc.', 'Data', 'Bairro', 'Local', 'Emergência', 'Viaturas'];
    const escapar = v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    const csv = [cabecalho, ...linhas].map(l => l.map(escapar).join(',')).join('\n');

    fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
    fs.writeFileSync(SAIDA, csv, 'utf8');

    // Uma ocorrência com duas viaturas vem em duas linhas — é a diferença que
    // o próprio E193 mostra no rodapé ("735 registros - Total 722 OCs").
    const ocs = new Set(linhas.map(l => l[0])).size;
    console.log(`✅ Gravado ${SAIDA}: ${linhas.length} linhas, ${ocs} ocorrências distintas.`);

  } catch (err) {
    console.error('Erro durante a coleta:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
