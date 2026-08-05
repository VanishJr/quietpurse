/**
 * The page behind "Back to Website" on the auth screens.
 *
 * It shares the palette, the type and the corner radii with those screens and
 * nothing else — no session, no /api call, no bundle in common. A landing page
 * that needed the app to be running would be a landing page that goes down with
 * it.
 *
 * The argument it makes, in order: here is your number (Hero) → here is why it is
 * different from everyone else's (Opinions) → here is how the data got in without
 * a bank ever being asked (Import) → and here is the month it gives you back
 * (Spending). Nothing on this page promises clarity, confidence or peace of mind;
 * every claim on it is either a number the visitor set themselves or a mechanism
 * they can go and read.
 */
import { Hero } from './Hero';
import { Import } from './Import';
import { Opinions } from './Opinions';
import { Spending } from './Spending';

const GITHUB = 'https://github.com/VanishJr/finto';

export function Landing() {
  return (
    <div className="landing">
      <a className="skip" href="#how">
        Skip to what it does
      </a>

      <header className="nav">
        <a className="nav-logo" href="#top">
          Finto
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href="#spending">Your month</a>
          <a href={GITHUB} rel="noreferrer noopener">
            Source
          </a>
          {/* the round trip: the auth screens' "Back to Website" points here */}
          <a className="nav-signin" href="/">
            Sign in
          </a>
        </nav>
      </header>

      <main id="top">
        <Hero />
        <Opinions />
        <Import />
        <Spending />
      </main>

      <footer className="foot">
        <p>
          Finto is MIT-licensed and unfinished in public. It is a personal finance tracker for
          people whose money is in more than one country and whose income is not all their own.
        </p>
        <p className="foot-links">
          <a href={GITHUB} rel="noreferrer noopener">
            Source
          </a>
          <a href="/">Sign in</a>
        </p>
      </footer>
    </div>
  );
}
