export function Welcome({ onStart, onDemo }: { onStart: () => void; onDemo: () => void }) {
  return (
    <section className="welcome">
      <p className="eyebrow">Know what you expected. See what you received. Find the difference.</p>
      <h1>Did your commission check add up?</h1>
      <p className="lead">Track your deals, record what you received, and see which amounts need a closer look.</p>
      <div className="welcome-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={onStart}>
          Start my tracker
        </button>
        <button type="button" className="btn btn-large" onClick={onDemo}>
          Try an example
        </button>
      </div>
      <p className="privacy-note">
        <span aria-hidden="true">🔒 </span>Your data stays in this browser. Export a backup to keep a separate copy.
      </p>
      <ol className="welcome-steps">
        <li>
          <strong>Set up your plan.</strong> Quota, base rate, and an optional accelerator.
        </li>
        <li>
          <strong>Add your deals.</strong> We work out what each one should pay.
        </li>
        <li>
          <strong>Record payments.</strong> Match them to deals and see what’s left to review.
        </li>
      </ol>
    </section>
  );
}
