# Livro de Contas (Android)

App Android para registar despesas e receitas, ver o mês e o ano, e acompanhar
contas poupança e ETFs. Os dados ficam só no telemóvel; a app faz cópias de
segurança para um ficheiro (Google Drive, email, Ficheiros).

## Como está montada

- `src/app.html` — a página da app (a mesma que corre em claude.ai).
- `src/native.js` — guarda os dados no telemóvel (Capacitor Preferences) e partilha ficheiros.
- `seed/default.json` — categorias base do primeiro arranque (a app começa sem movimentos; cada pessoa importa a sua cópia ou começa do zero).
- `scripts/build.mjs` — gera `www/` com as fontes incluídas.
- `android/` — projeto Android (Capacitor).

## Gerar o APK

Cada push para `main` corre `.github/workflows/android.yml`, que gera um APK
assinado e publica-o em **Releases**.

Segredos necessários no repositório (Settings → Secrets and variables → Actions):

| Segredo | Conteúdo |
| --- | --- |
| `LDC_KEYSTORE_B64` | o ficheiro `livro-de-contas.jks` em base64 |
| `LDC_KEYSTORE_PASSWORD` | a palavra-passe da chave |

Use sempre a mesma chave: o Android só aceita atualizar a app se o APK novo
for assinado com a mesma chave do anterior.

## Desenvolvimento local

```sh
npm ci
npm run build        # gera www/
npx cap sync android # copia www/ para o projeto Android
```
