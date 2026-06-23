// ============================================================================
//  Coletor E193 — versão headless (sem PC ligado) — COM DIAGNÓSTICO
//  Se algo der errado, salva "erro.png" (foto da tela) e "erro.html"
//  para descobrirmos o que a página realmente entregou.
//
//  Credenciais vêm das variáveis de ambiente (Secrets do GitHub),
//  nunca escritas aqui.
// ============================================================================

const { chromium } = require('playwright');
const fs = require('fs');

const USER      = process.env.E193_USER;
const PASS      = process.env.E193_PASS;
const URL_PONTE = process.env.URL_PONTE;

const URL_BASE = 'https://e193.cbm.rs.gov.br/index.php';
const CIDADE   = '325'; // Porto Alegre

// Identifica o robô como um Chrome comum (muitos sites recusam o "headless").
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (!USER || !PASS || !URL_PONTE) {
  console.error('ERRO: faltam variáveis E193_USER, E193_PASS ou URL_PONTE.');
  process.exit(1);
}

async function salvarDiagnostico(page, motivo) {
  try {
    console.log('--- DIAGNÓSTICO (' + motivo + ') ---');
    console.log('URL atual :', page.url());
    console.log('Título    :', await page.title());
    const inputs = await page.$$eval('input', els =>
      els.map(e => e.name || e.id || e.type || '?'));
    console.log('Campos input encontrados:', JSON.stringify(inputs));
    const cidadeVal = await page.evaluate(() => {
      const c = document.getElementById('id_cidade');
      return c ? c.value : '(campo ausente)';
    }).catch(() => '?');
    console.log('Valor de id_cidade:', JSON.stringify(cidadeVal));
    const texto = await page.evaluate(() =>
      (document.body ? document.body.innerText : '').slice(0, 600));
    console.log('Texto visível (início):\n' + texto);
    await page.screenshot({ path: 'erro.png', fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    fs.writeFileSync('erro.html', html);
    console.log('--- (foto e HTML salvos como erro.png / erro.html) ---');
  } catch (e) {
    console.log('Não consegui salvar o diagnóstico:', e.message);
  }
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

    // Mostra sempre o que chegou (ajuda mesmo quando dá certo).
    console.log('URL após abrir:', page.url(), '| Título:', await page.title());

    // ----- 1) LOGIN ---------------------------------------------------------
    // Nesta página o campo de usuário se chama "login" (não "usuario"),
    // e o botão "Entrar" dispara a função startE193().
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

    // Espera realmente sair da tela de login.
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

    // ----- 3) FILTRAR ------------------------------------------------------
    // O campo de cidade é um autocomplete: o NOME aparece na caixa visível, mas
    // o VALOR real (o código) fica no input escondido #id_cidade — que no robô
    // vem vazio. A busca (loadEscalas) lê #id_cidade.value, então colocamos o
    // código de Porto Alegre (325) direto nesse input e chamamos loadEscalas()
    // na mesma hora, sem tocar na parte visual (mexer nela quebrava a busca).
    try {
      await page.waitForSelector('input[value="Filtrar"]', { timeout: 45000 });
    } catch (e) {
      await salvarDiagnostico(page, 'botao Filtrar nao apareceu');
      throw e;
    }
    await page.waitForTimeout(1500);
    console.log('Definindo cidade (325) e filtrando...');
    await page.evaluate((cidade) => {
      const c = document.getElementById('id_cidade');
      if (c) c.value = cidade;
      if (typeof loadEscalas === 'function') loadEscalas();
    }, CIDADE);

    // ----- 4) ESPERAR A TABELA CARREGAR ------------------------------------
    console.log('Aguardando a tabela...');
    try {
      await page.waitForFunction(() => {
        const t = document.getElementById('lista_escala');
        if (!t) return false;
        const visivel = !t.classList.contains('d-none');
        const linhas  = t.querySelectorAll('tr').length;
        return visivel && linhas > 3;
      }, { timeout: 45000 });
    } catch (e) {
      await salvarDiagnostico(page, 'tabela nao carregou');
      throw e;
    }
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
      await salvarDiagnostico(page, 'tabela carregou mas nao extraiu dados');
      console.error('Nenhum dado extraído.');
      await browser.close();
      process.exit(1);
    }

    // ----- 6) ENVIAR PARA A PONTE ------------------------------------------
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
    console.error('Erro durante a coleta:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
