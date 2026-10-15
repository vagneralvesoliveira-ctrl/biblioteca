# Estante

Leitor de livros em domínio público para o celular, no estilo Kindle.

**Abrir o app:** https://vagneralvesoliveira-ctrl.github.io/biblioteca/

## Instalar no celular
- **Android (Chrome):** abra o link, toque nos três pontinhos ⋮ e em **Instalar app** (ou **Adicionar à tela inicial**).
- **iPhone (Safari):** abra o link, toque em **Compartilhar** e em **Adicionar à Tela de Início**.

## Como funciona
- **Explorar:** busca no acervo do Project Gutenberg (mais de 70 mil livros) e mostra a **Biblioteca pronta**.
- **Baixar:** o livro fica guardado no celular e abre sem internet.
- **Ler:** toque na direita/esquerda (ou deslize) para virar a página; toque no meio para o menu (tamanho da letra, tema claro/sépia/escuro, fonte, sumário).
- Segure o dedo sobre um livro da estante para removê-lo ou recomeçar.

## Livros que o celular não consegue baixar direto
O Gutenberg bloqueia downloads feitos de dentro de outros sites. Para esses livros, o app mostra o botão
**Pedir ao GitHub**: ele abre um pedido ("issue") já preenchido; basta confirmar. Uma automação baixa o livro,
coloca na **Biblioteca pronta** e fecha o pedido em cerca de 2 minutos.

Também dá para editar `livros.txt` diretamente (um número do Gutenberg por linha).

## Domínio público
O acervo segue a lei americana. No Brasil, a regra geral é de 70 anos contados de 1º de janeiro do ano
seguinte à morte do autor (Lei 9.610/98, art. 41); o app mostra essa conta na ficha de cada livro.
Traduções têm proteção própria, pelo tradutor.

## Arquivos
- `index.html`, `style.css`, `app.js` — o app
- `sw.js`, `manifest.json`, `icons/` — instalação e funcionamento offline
- `livros.txt` — lista da Biblioteca pronta
- `scripts/baixar_livros.py` e `.github/workflows/livros.yml` — automação que baixa os livros
- `books/`, `catalog.json` — gerados pela automação
