# MakerWorld Scraper (Scrapy)

Extrai de uma URL de modelo do MakerWorld:

- nome e descrição;
- URLs de imagens e arquivos baixados;
- melhor Print Profile (maior nota; em empate, maior quantidade de avaliações);
- peso de filamento e tempo de impressão **do mesmo perfil escolhido**.

## Instalação

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Uso

```bash
scrapy crawl makerworld_model \
  -a 'url=https://makerworld.com/en/models/139303-the-organizer'
```

Saída:

```text
output/<model_id>.json
output/images/<model_id>/...
```

Exemplo do JSON:

```json
[
  {
    "url": "https://makerworld.com/en/models/139303-the-organizer",
    "model_id": "139303",
    "name": "The Organizer",
    "description": "...",
    "images": [
      {"url": "...", "path": "139303/abc.webp", "checksum": "...", "status": "downloaded"}
    ],
    "image_urls": ["..."],
    "best_profile": {
      "id": "...",
      "name": "...",
      "rating": 4.9,
      "rating_count": 37,
      "print_time_seconds": 7200,
      "print_time": "2h",
      "weight_grams": 84.0
    }
  }
]
```

## Estratégia de extração

1. Metadados HTML estáveis (`og:title`, `og:description`, `og:image`).
2. JSON estruturado/hidratação encontrado em `<script>` para imagens e Print Profiles.
3. Fallback textual conservador quando o MakerWorld fornece perfil, nota, tempo e peso no HTML indexável.

Não depende de nomes de classes CSS gerados pelo frontend.

## Diagnóstico

Use o Scrapy shell para inspecionar uma página real:

```bash
scrapy shell 'https://makerworld.com/en/models/139303-the-organizer'
```

E teste:

```python
response.css('meta[property="og:title"]::attr(content)').get()
response.css('meta[property="og:image"]::attr(content)').getall()
response.xpath('//script/text()').getall()
```

## Testes

```bash
python -m unittest discover -s tests
```

## Observações

- `ROBOTSTXT_OBEY = True` por padrão.
- Uma requisição por domínio e AutoThrottle reduzem carga no site.
- Se o MakerWorld responder com página de desafio/bloqueio em sua rede, o Scrapy puro não deve tentar contornar CAPTCHA ou controles de acesso. Nesse caso, use uma sessão/navegador autorizado e alimente ao scraper o HTML permitido.

## Scrapy 2.17 compatibility

The project uses the Scrapy 2.17 item-pipeline signatures (`open_spider(self)` and `process_item(self, item)`).

Brotli support requires `Brotli>=1.2.0`; `pip install -r requirements.txt` upgrades it when necessary.

The spider is configured with `CLOSESPIDER_ITEMCOUNT = 1`. Since Scrapy emits `item_scraped` only after all item pipelines complete, image downloads and `output/<model_id>.json` persistence finish before the spider closes.
