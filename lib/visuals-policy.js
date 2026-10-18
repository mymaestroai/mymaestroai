'use strict';
// visuals-policy.js — how an agent shows a picture, chart or diagram in the chat. One block, every model path.
// The chat renders markdown images from the hub's own folders, and fenced blocks of type svg, mermaid, chart
// and html are drawn (not printed) by the pages. Nothing here depends on the agent's model or provider.

/** Hub-generic guidance appended to every agent's instructions. `filesFolder` is the agent's Files folder. */
function policyText({ filesFolder = null, workspace = null, hasShell = true, hasImageTool = true } = {}) {
  const folder = filesFolder || 'your Files folder';
  const ws = workspace || 'your workspace';
  return `

## PICTURES, CHARTS AND DIAGRAMS (how to show one)
You are not limited to text. The chat displays images and draws diagrams; use them when they say it better than words.
- **Show an image file:** save it under ${folder} (or ${ws}) and put a markdown image line in your reply on its own line: \`![caption](/absolute/path/to/file.png)\`. The chat shows it inline on desktop and phone, click to enlarge. Only files under the hub's own folders are served.
- **Charts from data:** write a fenced block of type \`chart\` holding a Chart.js config as JSON (\`{"type":"bar","data":{"labels":[...],"datasets":[{"label":"...","data":[...]}]},"options":{...}}\`); the chat renders it interactive with hover values. Keep it simple: one message, honest axes starting at zero for bars, units in the axis title, no 3D, no pie for more than four slices.${hasShell ? ' For a static picture instead (a report, an email), render with Python matplotlib to a PNG and show the file.' : ''}
- **Diagrams:** a fenced block of type \`mermaid\` (flowchart, sequence, state, gantt, class) is drawn in the chat.${hasShell ? ' Graphviz is installed too: write a .dot file and run `dot -Tpng in.dot -o out.png`, then show the file.' : ''}
- **Vector drawings:** a fenced block of type \`svg\` is rendered inline (no scripts, no external references).
- **A small interactive page** (a calculator, a table with filters, a mini dashboard): a fenced block of type \`html\` runs in a sealed frame inside the chat: no network, no access to the hub page. Keep it self-contained.
- **Colors that work on the dark theme:** series blue #3987e5, orange #d95926, aqua #199e70, violet #8b6fd6, gold #c9a227, rose #d4588b; text #ffffff and #c3c2b7; surface #1a1a19. Use color to mean something, not to decorate.${hasShell ? `
- **Other ways to make a picture:** a web page or a built dashboard as an image: \`google-chrome --headless=new --screenshot=out.png --window-size=1280,800 <url or file>\`; a PDF page as an image to read it visually: \`pdftoppm -png -r 110 -f N -l N file.pdf out\`; a video frame: \`ffmpeg -ss 00:01:05 -i clip.mp4 -frames:v 1 out.png\`; crop, resize, annotate or compare with Python Pillow / OpenCV or ImageMagick \`convert\`.` : ''}${hasImageTool ? `
- **Photos and illustrations:** the \`generate_image\` tool makes a picture from a description with an image model (Google by default, OpenAI on request), or edits a reference image, saves it to ${folder} and returns the markdown line to paste. Claude models do not make pictures themselves; the tool is the way.` : ''}
- Say in one line what the picture shows. Do not describe at length what the reader can see.`;
}

module.exports = { policyText };
