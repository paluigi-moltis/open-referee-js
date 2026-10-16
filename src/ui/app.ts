// Shared application entry. Stage 1 ships the app shell placeholder;
// the full UI (file ingest, run progress, report view) is wired in
// Stage 1 Wave C.
export function mountApp(root: HTMLElement): void {
  const heading = document.createElement('p');
  heading.textContent = 'Open Referee — app shell (scaffold).';
  root.appendChild(heading);
}
