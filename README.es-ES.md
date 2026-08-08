

<div align="center">

# Inkstone · 「砚」

**Exporta por lotes todo tu historial de chatgpt.com a Markdown compatible con Obsidian — un clic, en la página, totalmente local.**

*Una piedra de tinta tritura el pigmento en bruto para crear tinta de escritura. Inkstone te ayuda a convertir la salida sin procesar de GPT en tinta para tus notas.*

[![release](https://img.shields.io/github/v/release/ZhenHuangLab/inkstone)](https://github.com/ZhenHuangLab/inkstone/releases/latest)
[![downloads](https://img.shields.io/github/downloads/ZhenHuangLab/inkstone/total)](https://github.com/ZhenHuangLab/inkstone/releases)
[![license](https://img.shields.io/github/license/ZhenHuangLab/inkstone)](./LICENSE)
[![greasyfork](https://img.shields.io/greasyfork/v/586688)](https://greasyfork.org/scripts/586688)

**English** · [简体中文](./README.zh-CN.md)

</div>

<p align="center">
  <a href="https://www.tampermonkey.net/"><b>① Instalar Tampermonkey</b></a>
  &nbsp;→&nbsp;
  <a href="https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js"><b>② Instalar Inkstone</b></a>
  &nbsp;→&nbsp;
  <b>③ Abre chatgpt.com, pulsa ⤓</b>
</p>

---

## Por qué Inkstone

Tu historial de ChatGPT contiene trabajo real, pero exportarlo a un vault es un proceso doloroso. La exportación oficial es un volcado JSON en bruto: se eliminan los mensajes de herramientas y del sistema (la salida de Canvas y del intérprete de código simplemente no está), algunos archivos adjuntos ya expiraron en el servidor, las fórmulas matemáticas llegan con delimitadores `\( \)` que Obsidian no renderiza, y las citas de búsqueda web se convierten en caracteres Unicode privados ilegibles. Copiar y pegar manualmente no escala más allá de diez conversaciones, y menos aún de mil.

Inkstone se ejecuta dentro de chatgpt.com y obtiene las conversaciones a través de la misma API backend que usa la propia aplicación, luego convierte todo localmente en tu navegador — nada sale de la página. El resultado es un Markdown que se lee nativamente en Obsidian: encabezados reales por turno, matemáticas `$` / `$$`, citas resueltas, imágenes descargadas y un frontmatter limpio.

## Capturas de pantalla

| Interfaz del panel | Configuración avanzada |
| -------- | ----------------- |
| ![Interfaz del panel](./.github/assets/ui.png) | ![Configuración avanzada](./.github/assets/advanced-settings.png) |

| Exportación por lotes de todo | Exportación con selección múltiple |
| ---------------- | ------------------- |
| ![Exportación por lotes de todo](./.github/assets/all-export.png) | ![Exportación con selección múltiple](./.github/assets/multi-export.png) |

| Exportación directa a Obsidian | Mantener pensamientos / trazas de herramientas |
| --------------------------- | --------------------------- |
| ![Exportación directa a Obsidian](./.github/assets/export-to-obsidian.png) | ![Mantener pensamientos / trazas de herramientas](./.github/assets/keep-thoughts-and-tool-traces.png) |

| Mantener fórmulas y enlaces | Mantener archivos adjuntos e imágenes |
| ----------------- | ------------------------- |
| ![Mantener fórmulas y enlaces](./.github/assets/keep-formula-and-link.png) | ![Mantener archivos adjuntos e imágenes](./.github/assets/keep-attachments-and-images.png) |

## Características

### Calidad de conversión

- Los encabezados de nivel superior `# User` / `# ChatGPT` separan los turnos; los encabezados dentro de los mensajes se degradan un nivel (H1–H6)
- Conversión de delimitadores matemáticos `\( \)` / `\[ \]` → `$` / `$$` (consciente de los bloques de código); se escapa el `$` de moneda
- **Citas restauradas**: las citas de búsqueda web se convierten en enlaces inline `[fuente](url)` más una sección `# Fuentes` al final; las citas de archivos se convierten en notas con el nombre del archivo; todo lo que no se pueda resolver se elimina — nunca habrá marcadores ilegibles
- El `chain-of-thought` y las trazas de herramientas (código del intérprete de código, consultas de búsqueda, salida de ejecución) se envuelven en `callouts` colapsados y **no se escriben por defecto** — actívalos en la configuración avanzada ("escribir pensamientos" / "escribir trazas de herramientas"), o usa `--thoughts` / `--tool-traces` en la CLI
- Los tipos de contenido desconocidos se preservan íntegramente dentro de `callouts` colapsados — nada se elimina silenciosamente
- Frontmatter: `title / chat_id / url / created / updated / model / tags`

### Archivos adjuntos

- Cada imagen de una conversación se descarga en una subcarpeta de adjuntos junto a las notas (por defecto `conversations/attachments/`, incrustadas con `![[wikilink]]` de Obsidian)
- Los archivos subidos por el usuario ≤ 2 MB se descargan y enlazan; los más grandes reciben una nota de marcador de posición
- La disposición de carpetas es personalizable en la configuración: la subcarpeta de notas (por defecto `conversations`, anidable como `a/b`, vacío = raíz del vault) y la subcarpeta de adjuntos (por defecto `attachments`, relativa a la carpeta de notas, vacío = mismo nivel que las notas). Los enlaces de adjuntos son rutas relativas estrictas, por lo que también funcionan las vistas previas de GitHub y VS Code
- Un interruptor de "descargar adjuntos": desactívalo para una exportación solo de texto con drásticamente menos solicitudes

### Sincronización incremental

Una marca de agua registra `update_time` de cada conversación, por lo que las reexportaciones solo obtienen lo que cambió (se puede desactivar; el panel tiene un botón de "restablecer estado incremental"). La descarga completa y pesada solo ocurre una vez.

### Exportación JSON raw

Además de Markdown, Inkstone exporta un **zip JSON raw** — un seguro de datos y la fuente de los `fixtures` del convertidor.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/)
2. Haz clic en [el último inkstone.user.js](https://github.com/ZhenHuangLab/inkstone/releases/latest/download/inkstone.user.js) — el encabezado del script lleva una URL de actualización, por lo que las versiones futuras se actualizan automáticamente

O desde GreasyFork: [inkstone](https://greasyfork.org/scripts/586688)

O compilar desde el código fuente:

```bash
bun install
bun run build        # → dist/inkstone.user.js, arrástralo a Tampermonkey
```

## Uso

Abre chatgpt.com (iniciada la sesión) → haz clic en el **botón ⤓ a la izquierda del botón Compartir** en la barra superior → elige **Markdown zip** o **raw JSON zip** → descomprime en tu vault de Obsidian.

- La posición del botón es intercambiable (panel → configuración avanzada): junto a Compartir en la barra superior, o un botón translúcido junto al cuadro de entrada
- La IU sigue automáticamente la configuración de apariencia de ChatGPT (claro/oscuro + color de acento)
- Las exportaciones son cancelables; una sola conversación fallida nunca detiene el proceso — los fallos se resumen en `_failures.json`

## CLI sin conexión

La alternativa de riesgo cero: convierte el **zip de exportación oficial** de ChatGPT completamente sin conexión — nunca toca la API backend.

```bash
bun run offline <export.zip | extracted-dir> [-o outdir]
  [--thoughts] [--tool-traces] [--no-assets]
  [--link-style wikilink|markdown] [--heading-mode demote|strip]
  [--notes-dir <name>] [--attachments-dir <name>]
```

La estructura de salida coincide con la del userscript. Advertencia: el zip oficial solo contiene mensajes visibles de usuario/asistente — las cargas de herramientas/sistema (Canvas, intérprete de código) son eliminadas por OpenAI, y algunos archivos adjuntos referenciados ya han expirado en el servidor (se dejan marcadores de posición en su lugar).

## Desarrollo

```bash
bun install
bun run dev          # vite-plugin-monkey imprime una URL de instalación única; las ediciones se actualizan en caliente
bun test             # pruebas unitarias del convertidor (TS puro, no necesita navegador)
bun run typecheck
bun run build
```

## Hoja de ruta

Extensión de navegador MV3 (sin Tampermonkey, lanzamiento en tienda) y soporte para Claude / Gemini. Ya completado: sincronización incremental, escritura directa en un vault de Obsidian, panel de configuración, reproducción de parches de Canvas y la CLI sin conexión. Detalles en [PLAN.md](./PLAN.md) (en chino).

## Licencia

[GPL-3.0](./LICENSE)

## Enlaces relacionados

[LINUX DO](https://linux.do)
