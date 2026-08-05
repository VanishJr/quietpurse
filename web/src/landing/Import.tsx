/**
 * How the data gets in — the third step of the page's argument, between the two
 * opinions and the month they produce.
 *
 * The differentiator every competitor states as its own opposite. Theirs is
 * "13,000+ institutions"; this is "none, and it never asks for one".
 *
 * A file of its own, like its three siblings on this page: it was written inside
 * Landing.tsx and then simply stayed there.
 */
export function Import() {
  return (
    <section className="import" id="import">
      <div className="import-words">
        <h2 className="section-h">No bank ever gives Finto access.</h2>
        <p className="section-sub">
          There is no institution list to be on, no open-banking consent screen, no API key, and
          nothing to revoke later. You export the statement your bank already offers you, and you
          drop the file in. If your bank is small, or foreign, or offline, it makes no difference —
          it never had to have heard of Finto.
        </p>
        <p className="formats">
          <span>CSV</span>
          <span>XLSX</span>
          <span className="formats-note">the right parser is picked for you</span>
        </p>
      </div>

      <ol className="steps" aria-label="What happens to a statement">
        <li className="step">
          <p className="step-n">1</p>
          <div className="file">
            <span className="file-name">statement-2026-07.csv</span>
            <span className="file-size">41 KB</span>
          </div>
          <p className="step-say">A file you already had.</p>
        </li>
        <li className="step">
          <p className="step-n">2</p>
          <div className="rows">
            <span className="row">
              <b>04.07</b> BIEDRONKA 1204 <i>−119,90</i>
            </span>
            <span className="row">
              <b>04.07</b> Rent — July <i>−2 000,00</i>
            </span>
            <span className="row">
              <b>06.07</b> Transfer to Savings <i>−500,00</i>
            </span>
          </div>
          <p className="step-say">Read, and converted at each date's own rate.</p>
        </li>
        <li className="step">
          <p className="step-n">3</p>
          <div className="rows">
            <span className="row">
              BIEDRONKA 1204 <em className="tag">Groceries</em>
            </span>
            <span className="row">
              Rent — July <em className="tag">Housing</em>
            </span>
            <span className="row row-muted">
              Transfer to Savings <em className="tag tag-muted">Not spending</em>
            </span>
          </div>
          <p className="step-say">
            Categorised by rule, and the transfer between your own accounts recognised as one —
            money moving is not money spent.
          </p>
        </li>
      </ol>
    </section>
  );
}
