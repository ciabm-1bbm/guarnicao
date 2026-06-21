// ============================================================================
//  Coletor E193 — versão headless (sem PC ligado)
//  Porte fiel do Tampermonkey "Coletor E193 - V37" para Playwright.
//  Faz login, navega até a escala, filtra Porto Alegre (cidade 325),
//  lê a tabela e envia os dados para a mesma "ponte" do Google Apps Script.
//
//  As credenciais NÃO ficam escritas aqui. Vêm das variáveis de ambiente,
//  que no GitHub são guardadas com segurança em "Secrets".
// ============================================================================

const { chromium } = require('playwright');

const USER      = process.env.E193_USER;   // seu id funcional
const PASS      = process.env.E193_PASS;   // sua senha
const URL_PONTE = process.env.URL_PONTE;   // URL do seu Google Apps Script (/exec)

const URL_BASE = 'https://e193.cbm.rs.gov.br/index.php';
const CIDADE   = '325'; // código de Porto Alegre, igual ao do seu V37

if (!USER || !PASS || !URL_PONTE) {
  console.error('ERRO: faltam variáveis E193_USER, E193_PASS ou URL_PONTE.');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // Fixa o fuso de Brasília para a data padrão da página sair correta,
  // mesmo o servidor do GitHub rodando em UTC.
  const context = await browser.newContext({
    timezoneId: 'America/Sao_Paulo',
    locale: 'pt-BR',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    console.log('Abrindo o E193...');
    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

    // ----- 1) LOGIN ---------------------------------------------------------
    await page.waitForSelector('input[name="usuario"]');
    await page.fill('input[name="usuario"]', USER);
    await page.fill('input[name="senha"]', PASS);
    console.log('Fazendo login...');
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    await page.waitForTimeout(2000);

    // ----- 2) NAVEGAR ATÉ A ESCALA -----------------------------------------
    console.log('Navegando para a escala...');
    const navegouPelaFuncao = await page.evaluate(() => {
      if (typeof loadModulo === 'function') {
        loadModulo('gua', '23', 'cons_guarnicao.php');
        return true;
      }
      return false;
    }).catch(() => false);

    if (!navegouPelaFuncao) {
      const link = await page.$('a[href*="cons_guarnicao.php"]');
      if (link) await link.click();
    }

    // ----- 3) FILTRAR CIDADE (Porto Alegre = 325) --------------------------
    await page.waitForSelector('#id_cidade', { timeout: 45000 });
    await page.waitForTimeout(1500);
    console.log('Filtrando cidade...');
    await page.evaluate((cidade) => {
      const c = document.getElementById('id_cidade');
      if (!c) return;
      c.value = cidade;
      if (window.jQuery) window.jQuery('#id_cidade').val(cidade).trigger('change');
      else c.dispatchEvent(new Event('change', { bubbles: true }));
    }, CIDADE);

    const btnFiltrar = await page.$('input[value="Filtrar"]');
    if (btnFiltrar) await btnFiltrar.click();
    else await page.evaluate(() => { if (typeof loadEscalas === 'function') loadEscalas(); });

    // ----- 4) ESPERAR A TABELA CARREGAR ------------------------------------
    console.log('Aguardando a tabela...');
    await page.waitForFunction(() => {
      const t = document.getElementById('lista_escala');
      if (!t) return false;
      const visivel = !t.classList.contains('d-none');
      const linhas  = t.querySelectorAll('tr').length;
      return visivel && linhas > 5;
    }, { timeout: 45000 });
    await page.waitForTimeout(1500);

    // ----- 5) EXTRAIR (lógica idêntica ao V37) -----------------------------
    console.log('Extraindo dados...');
    const dados = await page.evaluate(() => {
      const tabela = document.getElementById('lista_escala');
      const linhas = tabela.querySelectorAll('tr');
      const out = [];
      let obmAtual = 'GERAL';
      let vtrAtual = 'IND';
      const ts = () => new Date().toISOString();

      for (const tr of linhas) {
        if (tr.classList.contains('dtrg-level-1')) { obmAtual = tr.innerText.trim(); continue; }
        if (tr.classList.contains('dtrg-level-2')) { vtrAtual = tr.innerText.split('(')[0].trim(); continue; }

        if (tr.classList.contains('odd') || tr.classList.contains('even')) {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 7) {
            let nome   = cells[1]?.innerText.trim() || '';
            let funcao = cells[2]?.innerText.trim() || '';
            const horaIni = cells[4]?.innerText.trim() || '';
            const horaFim = cells[6]?.innerText.trim() || '';
            const horario = (horaIni && horaFim) ? `${horaIni} ${horaFim}` : (horaIni || '');

            if (!nome || nome === 'ND' || !funcao) {
              const textoLinha = tr.innerText.replace(/\n/g, ' ').trim();
              const m = textoLinha.match(/(SD|CB|SGT|TEN|CAP|MAJ|TC|CEL|ASP|SUB|AL)\s+[^0-9]+/i);
              if (m) nome = m[0].trim();
              if (!funcao) funcao = 'ND';
            }
            if (nome && nome !== 'ND') {
              out.push({ obm: obmAtual, vtr: vtrAtual, nome, func: funcao, horario, timestamp_extracao: ts() });
            }
          } else {
            const textoLinha = tr.innerText.replace(/\n/g, ' ').trim();
            const horarios = textoLinha.match(/\b\d{2}:\d{2}\b/g) || [];
            const horario = horarios.join(' ');
            let nome = 'ND';
            const m = textoLinha.match(/(SD|CB|SGT|TEN|CAP|MAJ|TC|CEL|ASP|SUB|AL)\s+[^0-9]+/i);
            if (m) nome = m[0].trim();
            let func = textoLinha;
            if (nome !== 'ND') func = func.replace(nome, '');
            horarios.forEach(h => { func = func.replace(h, ''); });
            func = func.replace(/\d{2}\/\d{2}\/\d{4}/g, '').replace(/[0-9]{7}/g, '').replace(/[-]/g, '').trim();
            if (func.length < 3) func = 'ND';
            if (nome !== 'ND') {
              out.push({ obm: obmAtual, vtr: vtrAtual, nome, func, horario, timestamp_extracao: ts() });
            }
          }
        }
      }
      return out;
    });

    if (!dados.length) {
      console.error('Nenhum dado extraído. A estrutura da página pode ter mudado.');
      await browser.close();
      process.exit(1);
    }

    // ----- 6) ENVIAR PARA A PONTE (Google Apps Script) ---------------------
    console.log(`Extraídos ${dados.length} registros. Enviando para a ponte...`);
    const resp = await fetch(URL_PONTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dados, timestamp_extracao: new Date().toISOString() }),
    });
    console.log(`Resposta da ponte: HTTP ${resp.status}`);
    if (resp.status !== 200) process.exitCode = 1;
    else console.log('✅ Sucesso!');

  } catch (err) {
    console.error('Erro durante a coleta:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
