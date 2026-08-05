/**
 * Sign in, register, and the three screens of password recovery. The only screen
 * reachable without a session — everything else in the app is behind it (see
 * App.tsx).
 *
 * One form in five modes rather than five screens: the fields are almost the same,
 * and someone who mistyped their email on the register tab shouldn't have to
 * retype it after switching to login — or after going to Forgot Password and back.
 * The session itself is a cookie set by the backend, so there is nothing to store
 * here — on success the app just re-checks the session and renders.
 *
 * The look is Figma design file: node 2008:79 login, 2012:698 register,
 * 2009:577 forgot password, 2011:652 check your email, 2012:713 reset password.
 * It is pinned — this screen ignores the light/dark theme the rest of the app
 * follows. Everything the design asks for that the server cannot answer — the
 * whole of password recovery, the remember-me flag on the wire, the website behind
 * "Back to Website", a surname of its own, a terms document, a complexity policy —
 * is written down in REDESIGN-BACK-DEBT.md rather than faked here.
 *
 * Two of the five cannot be reached: "Check your Email!" and "Reset Password" are
 * each opened by a server answer this deployment cannot give, and Forgot Password
 * refuses before it would navigate. The transitions between them are deliberately
 * unwritten rather than stubbed — see debt §1, and `initialMode` below.
 *
 * One departure from that frame, asked for after it was built: no photo. The card
 * is centred on the dark ground instead of sitting in the right half of a split,
 * and Logo and "Back to Website" keep the corners they had — they were over the
 * photo, they are now over the ground. Every measurement inside the card is the
 * frame's, unchanged.
 */
import { ChangeEvent, FormEvent, ReactNode, useEffect, useState } from 'react';
import { auth, AuthAttempt, MIN_PASSWORD } from '../api';
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CircleXIcon,
  EyeIcon,
  EyeOffIcon,
  TriangleAlertIcon,
} from '../components/AuthIcons';
import { CodeInput } from '../components/CodeInput';

type Mode = 'login' | 'register' | 'forgot' | 'code' | 'reset' | 'done';

/** The frame says "A 6-digit verification code", and draws six boxes. */
const CODE_LENGTH = 6;

const emptyCode = (): string[] => Array<string>(CODE_LENGTH).fill('');

/**
 * The three recovery screens all end at a server that cannot do any of it: no
 * `sendResetPassword`, no mail transport, so better-auth mounts neither
 * `/forget-password` nor `/reset-password` and both are 404s. One sentence for all
 * three, because the missing thing is the same missing thing. See debt §1.
 */
const NO_RECOVERY =
  'Password recovery is not set up on this server — there is nothing here that can send a reset ' +
  'email or accept a new password. Sign in with the password you have, or ask whoever runs this ' +
  'server.';

/**
 * Each frame's own words, gathered rather than spread over three nested ternaries
 * at three places in the markup.
 *
 * Two of the forgot frame's are not here. It labels the box "Email or Phone
 * Number" and asks for "your email address or phone number", and this server signs
 * nobody in by phone — the same disagreement §5 of REDESIGN-BACK-DEBT.md already
 * records for the login frames, answered the same way.
 */
const WORDS: Record<Mode, { heading: string; sub: string; action: string }> = {
  login: {
    heading: 'Welcome Back!',
    sub: 'Sign in to your data.',
    action: 'Login',
  },
  register: {
    heading: 'Create an account',
    sub: 'A new account comes with its own workspace — nobody else on this server sees its data.',
    action: 'Create account',
  },
  forgot: {
    heading: 'Forgot Password?',
    sub: 'Enter your email address',
    action: 'Reset Password',
  },
  code: {
    heading: 'Check your Email!',
    sub: `A ${CODE_LENGTH}-digit verification code has been sent to your email. Enter the code below to reset your password.`,
    action: 'Verify Code',
  },
  reset: {
    heading: 'Reset Password',
    sub: 'Enter your new password',
    action: 'Change my Password',
  },
  /**
   * The one screen here with no frame behind it. The Figma file draws the reset
   * and stops, and a flow that ends by leaving somebody on the form they have just
   * submitted has not ended. So: the frame's own tick, its heading, its sentence
   * and its button, and nothing invented but the arrangement. Replace it if a
   * frame ever arrives.
   */
  done: {
    heading: 'Password Changed!',
    // the heading already says it changed; repeating that just to fill a line
    // wraps to two and leaves "new one." alone on the second
    sub: 'Sign in with your new password.',
    action: 'Sign in',
  },
};

/**
 * The four rules the register frame draws under the password box, in its order.
 *
 * Only the first one refuses anything, and it is the pre-flight that was already
 * here: the server's whole password policy is better-auth's minPasswordLength
 * (backend/src/auth.ts), so the other three are advice this client has invented
 * and cannot enforce — blocking on them would refuse passwords the server accepts,
 * and the same account could then be made from any other client. They report,
 * they do not gate. See REDESIGN-BACK-DEBT.md §6.
 *
 * The length is MIN_PASSWORD, not the frame's 6. Printing 6 next to a server that
 * refuses anything under 8 is a rule that fails the moment somebody follows it.
 *
 * \p{...} rather than [a-z]: a password is not required to be Latin, and
 * /[A-Z]/ would tell someone typing Cyrillic they had used no capital when they
 * had. "A symbol" is then everything that is neither a letter nor a number.
 */
const PASSWORD_RULES: { text: string; met: (password: string) => boolean }[] = [
  { text: `Use ${MIN_PASSWORD} or more characters`, met: (p) => p.length >= MIN_PASSWORD },
  {
    text: 'Use upper and lower case letters (e.g. Aa)',
    met: (p) => /\p{Ll}/u.test(p) && /\p{Lu}/u.test(p),
  },
  { text: 'Use a number (e.g. 1234)', met: (p) => /\p{N}/u.test(p) },
  { text: 'Use a symbol (e.g. !@#$)', met: (p) => /[^\p{L}\p{N}]/u.test(p) },
];

/**
 * A refusal this screen made itself, before any request went out. 'signed-in' is
 * excluded rather than given an arm returning null: the success member is then
 * unable to reach the message at all.
 */
type Feedback =
  | Exclude<AuthAttempt, { outcome: 'signed-in' }>
  /**
   * `about` is which box it is a complaint about, and null when it is a complaint
   * about none of them — a code that is not six digits yet is about the row, and a
   * reset this server cannot perform is about nothing the person typed.
   */
  | { outcome: 'not-sent'; message: string; about: 'password' | 'confirm' | null };

/**
 * The sentence is composed here, from the member. Nothing the server wrote is
 * printed except by 'unexpected', which frames it as the server's words - a
 * message this client has no name for is still the only thing the person has.
 *
 * The design draws one refusal ("Something went wrong. Please try again.") and
 * these are ten. The treatment is the design's; the sentences stay, because
 * telling a typo from a rate limit is the whole point of them.
 */
function sentence(feedback: Feedback): ReactNode {
  switch (feedback.outcome) {
    case 'bad-email':
      return (
        <>
          That is not a complete email address. Check it for a typo — an address like ivan@gmail is
          missing its ending, for example ivan@example.com.
        </>
      );
    case 'wrong-credentials':
      // the server refuses to say which of the two it was, and neither does this
      return <>That email and password do not match an account here.</>;
    case 'email-taken':
      return <>There is already an account with that address. Sign in instead.</>;
    case 'password-too-short':
      // only reachable once MIN_PASSWORD has drifted from the server's minimum, so
      // the number this client holds is the one number known to be wrong here
      return <>That password is too short for this server.</>;
    case 'rate-limited':
      // one member for a 429 on either tab, and the windows differ 60x between them
      // (auth.ts:95-96); whether the bucket is shared is the deployment's business,
      // not this client's. So: no tab, no interval, no account of whose fault it was
      return <>Too many attempts on this server just now — wait and try again.</>;
    case 'malformed-request':
      return (
        <>
          Finto sent this server something it would not accept. That is a bug in Finto, not
          something you can fix here.
        </>
      );
    case 'unreachable':
      return (
        <>
          Finto could not reach the server, so it does not know whether that worked. This is not a
          problem with your account or your password. ({feedback.reason})
        </>
      );
    case 'unexpected':
      return <>The server refused this. It said: {feedback.detail}</>;
    case 'not-sent':
      return <>{feedback.message}</>;
    default: {
      const unhandled: never = feedback;
      return unhandled;
    }
  }
}

/**
 * The refusal is published under one id, so the boxes it is about can point at it
 * and a screen reader can be told which sentence belongs to which field.
 */
const ERROR_ID = 'auth-error';

/**
 * One element for every refusal, and it keeps the `error` class: the icon is the
 * design's, the class is what the rest of the app and the tests already select on.
 *
 * `role="alert"` because this element does not exist until the refusal does: it is
 * inserted, and an inserted alert is read out. Without it the whole of what this
 * screen says when something goes wrong was available to sighted people only — the
 * icon is aria-hidden, the #ECEEA9 fill is a colour, and the sentence simply
 * appeared in silence.
 */
function Message({ feedback }: { feedback: Feedback }) {
  return (
    <p className="error" id={ERROR_ID} role="alert">
      <TriangleAlertIcon />
      {sentence(feedback)}
    </p>
  );
}

/**
 * What a box is described by: its own hint, if it has one, and the refusal when the
 * refusal is about it. The fill the design puts on that box says "this one" in a
 * colour; this is the same sentence said in a way that does not depend on seeing it.
 */
const describes = (wrong: boolean, own?: string): string | undefined =>
  [own, wrong ? ERROR_ID : null].filter(Boolean).join(' ') || undefined;

/**
 * The four rules and where the typed password stands against each. Shown from the
 * moment the register tab opens, empty box and all — the frame draws the list as
 * part of the form, and advice withheld until after the guess has been made is
 * advice arriving at the one moment it is no use.
 *
 * An empty box is the state the frame never drew — it only ever shows this list
 * against a filled password — so it is chosen here, and it is not four red
 * crosses: nothing has been typed, so nothing is wrong yet, and the marks stay
 * grey until the box has something in it (auth.css, .is-untouched).
 *
 * The icon carries the whole of it: the sentences stay #595959 throughout,
 * exactly as the frame sets them. `.auth-sr` is what makes the mark reach a
 * screen reader, which cannot see a circle turn red.
 */
function PasswordRules({ password }: { password: string }) {
  return (
    <ul
      className={`auth-rules${password ? '' : ' is-untouched'}`}
      id="auth-password-rules"
      aria-label="Password requirements"
    >
      {PASSWORD_RULES.map((rule) => {
        const met = rule.met(password);
        return (
          <li className={`auth-rule${met ? ' is-met' : ''}`} key={rule.text}>
            {met ? <CircleCheckIcon /> : <CircleXIcon />}
            <span className="auth-rule-text">{rule.text}</span>
            <span className="auth-sr">{met ? '(done)' : '(not yet)'}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Which box the design's #ECEEA9 fill lands on. A refusal that is not about a
 * field tints nothing - a rate limit is not a wrong address, and colouring the
 * boxes for one would send the person to retype something that is already right.
 *
 * 'wrong-credentials' tints both because the server deliberately declines to say
 * which of the two it was, and tinting one would answer a question it refused.
 */
function wrongBoxes(feedback: Feedback | null): {
  email: boolean;
  password: boolean;
  confirm: boolean;
} {
  const none = { email: false, password: false, confirm: false };
  if (!feedback) return none;
  switch (feedback.outcome) {
    case 'bad-email':
    case 'email-taken':
      return { ...none, email: true };
    case 'password-too-short':
      return { ...none, password: true };
    // the client-side ones say which box they are about, and some say none
    case 'not-sent':
      return {
        ...none,
        password: feedback.about === 'password',
        confirm: feedback.about === 'confirm',
      };
    case 'wrong-credentials':
      return { ...none, email: true, password: true };
    default:
      return none;
  }
}

/**
 * A labelled password box, with the eye where the frame draws one. Three of these
 * now — login/register's, and the two on Reset Password — and the confirm box is
 * the one without: `2012:713` gives it no eye, which is also the point of a box
 * whose whole job is to be typed twice.
 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  wrong,
  shown,
  onToggleShown,
  autoComplete,
  placeholder,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  wrong: boolean;
  shown: boolean;
  /** Omitted where the frame draws no eye, which is what removes it. */
  onToggleShown?: () => void;
  autoComplete: string;
  placeholder?: string;
  describedBy?: string;
}) {
  const input = (
    <input
      id={id}
      className={`auth-input${wrong ? ' is-wrong' : ''}`}
      type={shown ? 'text' : 'password'}
      required
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      // the fill is the design's way of saying which box; this is the same fact in
      // the one place assistive technology reads it from
      aria-invalid={wrong || undefined}
      aria-describedby={describedBy}
    />
  );
  const named = label.toLowerCase();
  return (
    <div className="auth-field">
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      {onToggleShown ? (
        <div className="auth-input-wrap">
          {input}
          <button
            className="auth-eye"
            type="button"
            aria-pressed={shown}
            aria-label={shown ? `Hide ${named}` : `Show ${named}`}
            onClick={onToggleShown}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      ) : (
        input
      )}
    </div>
  );
}

export function AuthScreen({
  onSignedIn,
  initialMode = 'login',
}: {
  onSignedIn: () => void;
  /**
   * Which of the five screens to open on. App.tsx does not pass it — login is the
   * way in, and always has been.
   *
   * It exists because "Check your Email!" and "Reset Password" cannot be reached
   * through the app at all: each is opened by a server answer that this deployment
   * cannot give (debt §1), so without a seam they would be markup nothing renders
   * and no test can reach. It is also the seam the real flow will need — a reset
   * link arrives as a URL with a token in it, and something has to turn that URL
   * into a screen.
   */
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // two boxes, one column on the wire: /sign-up/email takes a single `name` string
  // and there is nowhere to put a surname of its own (debt §8)
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteRequired, setInviteRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  // real state, and it goes nowhere: /sign-in/email takes a rememberMe flag that
  // api.ts does not send yet, and what the cookie actually does with it can only be
  // read off a live server. See REDESIGN-BACK-DEBT.md §2.
  const [rememberMe, setRememberMe] = useState(false);
  // the recovery screens' own boxes, kept apart from `password` above: none of
  // them is the password anybody is signing in with
  const [codeDigits, setCodeDigits] = useState<string[]>(emptyCode);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // likewise real and likewise going nowhere, and deliberately not a gate: there is
  // no terms document to agree to and no field on the server that would remember
  // the agreeing, so refusing to make an account without it would make a fiction
  // compulsory. See debt §7.
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  // A public server can be invite-only; ask once so the form knows whether to
  // show the field at all rather than making everyone wonder what it is.
  useEffect(() => {
    void auth.signupMode().then((m) => setInviteRequired(m === 'invite'));
  }, []);

  /**
   * Focus follows the refusal to the box it is about — but only when it is about
   * one box.
   *
   * 'wrong-credentials' tints two, deliberately, because the server will not say
   * which of them it was (wrongBoxes above). Sending somebody to the first of the
   * two would be a guess wearing the clothes of guidance, and the guess it makes is
   * the wrong one nearly every time: an address that has been typed a hundred times
   * is rarely the thing that just failed. So there, focus stays where the person
   * left it and the alert does the work.
   */
  useEffect(() => {
    if (!feedback) return;
    const boxes = wrongBoxes(feedback);
    const named = (
      [
        [boxes.email, 'auth-email'],
        [boxes.password, mode === 'reset' ? 'auth-new-password' : 'auth-password'],
        [boxes.confirm, 'auth-confirm-password'],
      ] as const
    ).filter(([isWrong]) => isWrong);
    if (named.length === 1) document.getElementById(named[0][1])?.focus();
  }, [feedback, mode]);

  /**
   * A refusal is about what was in the boxes when it was composed, so the first
   * keystroke into any of them ends it: the sentence is about a screen that is no
   * longer on display, and the #ECEEA9 fill under it points at a box somebody is
   * already putting right. Left alone it sat there through the whole correction and
   * only cleared on the next submit.
   *
   * Every box clears it and not only the box it named — 'wrong-credentials' is a
   * complaint about the pair, and changing either half answers it.
   */
  const typing =
    (set: (next: string) => void) =>
    (e: ChangeEvent<HTMLInputElement>) => {
      set(e.target.value);
      setFeedback(null);
    };

  /** the same, for the two children that hand over a value rather than an event */
  const setting =
    <T,>(set: (next: T) => void) =>
    (next: T) => {
      set(next);
      setFeedback(null);
    };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    /**
     * The three recovery screens, and every one of them ends at the same wall.
     *
     * Nothing to send: better-auth mounts /forget-password and /reset-password only
     * once `sendResetPassword` is supplied, backend/src/auth.ts supplies nothing of
     * the kind, and there is no mail transport in the backend at all — so a request
     * would be answered 404 by the API's catch-all and these screens would print
     * the words of a route that does not exist.
     *
     * Said here instead, in Finto's own voice, and said only after the button is
     * pressed: the screens otherwise behave exactly as they will once the server
     * can answer. What runs before the refusal is everything this client can decide
     * by itself, and it is not skipped just because the request is not going out —
     * a code that is not six digits and two passwords that disagree are wrong
     * whatever the server can do, and those checks stay when the rest is wired up.
     * See debt §1.
     */
    if (mode === 'forgot') {
      setFeedback({ outcome: 'not-sent', about: null, message: NO_RECOVERY });
      return;
    }
    if (mode === 'code') {
      if (codeDigits.some((digit) => !digit)) {
        setFeedback({
          outcome: 'not-sent',
          about: null,
          message: `That code is not complete — it is ${CODE_LENGTH} digits.`,
        });
        return;
      }
      setFeedback({ outcome: 'not-sent', about: null, message: NO_RECOVERY });
      return;
    }
    if (mode === 'reset') {
      // before the length and not after: two passwords that disagree do not say
      // which of them was meant, so there is nothing yet to measure
      if (newPassword !== confirmPassword) {
        setFeedback({ outcome: 'not-sent', about: 'confirm', message: 'Password mismatch' });
        return;
      }
      if (newPassword.length < MIN_PASSWORD) {
        setFeedback({
          outcome: 'not-sent',
          about: 'password',
          message: `Password: at least ${MIN_PASSWORD} characters`,
        });
        return;
      }
      setFeedback({ outcome: 'not-sent', about: null, message: NO_RECOVERY });
      return;
    }
    // deliberately not on the login tab: there a short password is a wrong password,
    // and naming its length names a cause that is not the cause
    if (mode === 'register' && password.length < MIN_PASSWORD) {
      setFeedback({
        outcome: 'not-sent',
        about: 'password',
        message: `Password: at least ${MIN_PASSWORD} characters`,
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result =
      mode === 'register'
        ? // the name is optional for the user, but better-auth wants a string; the
          // two boxes are joined with a space, and the part before @ is a reasonable
          // stand-in when both are empty
          await auth.register(
            email.trim(),
            password,
            [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') ||
              email.trim().split('@')[0],
            inviteRequired ? inviteCode.trim() : undefined,
          )
        : await auth.login(email.trim(), password);
    setBusy(false);
    // the only call site: it re-checks the session, so firing it on a failure asks
    // the server a question that answers "signed out" and says nothing to anyone
    if (result.outcome === 'signed-in') {
      onSignedIn();
      return;
    }
    setFeedback(result);
  };

  const goTo = (next: Mode) => {
    setMode(next);
    // a refusal composed for the screen being left is a wrong sentence about the
    // one being arrived at
    setFeedback(null);
    // The address survives the trip and the password does not. `email` is the whole
    // reason these are modes rather than screens — somebody who mistyped it on one
    // tab should not retype it on the other — and none of these four is that: a
    // half-typed code and a new password belong to the screen that asked for them,
    // and an eye left open on one screen should not open the next one's box.
    setCodeDigits(emptyCode());
    setNewPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  };

  const login = mode === 'login';
  const register = mode === 'register';
  const enteringCode = mode === 'code';
  const resetting = mode === 'reset';
  const done = mode === 'done';
  // three of the five ask for an address; the other two are past that point
  const asksEmail = login || register || mode === 'forgot';
  const words = WORDS[mode];
  const wrong = wrongBoxes(feedback);

  // one field, two places: on register it heads a block the login screen has
  // nothing to put in, so it is written once here rather than in both arms below.
  // The recovery screens render neither — a person who could type their password
  // would not be on them.
  const passwordField = (
    <PasswordField
      id="auth-password"
      label="Password"
      value={password}
      onChange={setting(setPassword)}
      wrong={wrong.password}
      shown={showPassword}
      onToggleShown={() => setShowPassword(!showPassword)}
      placeholder={register ? `${MIN_PASSWORD}+ characters` : undefined}
      autoComplete={register ? 'new-password' : 'current-password'}
      // the rules are advice about this box, and a person who cannot see them turn
      // green has to hear them when they arrive at it — and the refusal, when there
      // is one about this box, is the other thing being said about it
      describedBy={describes(wrong.password, register ? 'auth-password-rules' : undefined)}
    />
  );

  // data-mode is read by auth.css, not by anything here: the register screen
  // carries a second name box, four password rules and a terms row that login does
  // not, and stands a third taller for them, so it runs at a tighter scale than the
  // window's band alone would give it (see --s there). Forgot Password is the
  // shortest of the three and takes the band unchanged.
  return (
    <div className="auth" data-mode={mode}>
      <header className="auth-topbar">
        {/* the design's "Logo"; there is no logo asset yet (debt §4) */}
        <p className="auth-logo">Finto</p>
        {/* it goes to the landing page, which is a second Vite entry rather than a
            route — the app has no router, and this is a page, not a screen (§3) */}
        <a className="auth-back" href="/landing.html">
          <ArrowLeftIcon />
          Back to Website
        </a>
      </header>

      <main className="auth-middle">
        <div className="auth-panel">
          <div className={`auth-col${done ? ' auth-done' : ''}`}>
            {/* the rules list's tick, at the one size nothing in this design was
                drawn at — see the note on its `size` in AuthIcons. The span is what
                colours it: the stroke is currentColor and `.auth` sets #000 */}
            {done && (
              <span className="auth-mark">
                <CircleCheckIcon size={64} />
              </span>
            )}

            <h1 className="auth-heading">{words.heading}</h1>
            <p className="auth-sub">{words.sub}</p>

            {/* nothing to submit: the person has finished, and the only thing left
                to do is the thing they came to do */}
            {done && (
              <button className="auth-submit" type="button" onClick={() => goTo('login')}>
                {words.action}
              </button>
            )}

            {!done && (
              <form className="auth-form" onSubmit={submit}>
                {/* 220 + 21 + 220 across the frame's 461, and both stay optional:
                    the server has never asked for a name, and the redesign is not
                    the place to start refusing accounts without one */}
                {register && (
                  <div className="auth-names">
                    <div className="auth-field">
                      <label className="auth-label" htmlFor="auth-name">
                        Name
                      </label>
                      <input
                        id="auth-name"
                        className="auth-input"
                        value={firstName}
                        onChange={typing(setFirstName)}
                        placeholder="Optional"
                        autoComplete="given-name"
                      />
                    </div>
                    <div className="auth-field">
                      <label className="auth-label" htmlFor="auth-last-name">
                        Last name
                      </label>
                      <input
                        id="auth-last-name"
                        className="auth-input"
                        value={lastName}
                        onChange={typing(setLastName)}
                        placeholder="Optional"
                        autoComplete="family-name"
                      />
                    </div>
                  </div>
                )}

                {asksEmail && (
                  <div className="auth-field">
                    <label className="auth-label" htmlFor="auth-email">
                      Email
                    </label>
                    <input
                      id="auth-email"
                      className={`auth-input${wrong.email ? ' is-wrong' : ''}`}
                      type="email"
                      required
                      value={email}
                      onChange={typing(setEmail)}
                      autoComplete="email"
                      aria-invalid={wrong.email || undefined}
                      aria-describedby={describes(wrong.email)}
                    />
                  </div>
                )}

                {/* Six boxes and no <label for>: there is no one box for "Enter Code"
                    to name, so it names the row and the boxes name themselves */}
                {enteringCode && (
                  <div className="auth-field">
                    <span className="auth-label" id="auth-code-label">
                      Enter Code
                    </span>
                    <CodeInput
                      value={codeDigits}
                      onChange={setting(setCodeDigits)}
                      labelledBy="auth-code-label"
                      disabled={busy}
                    />
                  </div>
                )}

                {/* the same 26px block register uses, and for the same reason: the
                    rules belong to the box above them, and 2012:713 draws the confirm
                    box the same distance under the rules */}
                {resetting && (
                  <div className="auth-tight">
                    <PasswordField
                      id="auth-new-password"
                      label="New Password"
                      value={newPassword}
                      onChange={setting(setNewPassword)}
                      wrong={wrong.password}
                      shown={showPassword}
                      onToggleShown={() => setShowPassword(!showPassword)}
                      autoComplete="new-password"
                      describedBy={describes(wrong.password, 'auth-password-rules')}
                    />
                    <PasswordRules password={newPassword} />
                    {/* no eye, per the frame, and it is the right frame to leave one
                        off: a box that exists to be typed a second time proves nothing
                        if it can be read off the first */}
                    <PasswordField
                      id="auth-confirm-password"
                      label="Confirm New Password"
                      value={confirmPassword}
                      onChange={setting(setConfirmPassword)}
                      wrong={wrong.confirm}
                      shown={false}
                      autoComplete="new-password"
                      describedBy={describes(wrong.confirm)}
                    />
                  </div>
                )}

                {login && passwordField}

                {/* the frame draws these three 26px apart rather than the form's 34
                    — they are one thing, the password and what is being said about
                    it — so they are one child of the form and space themselves */}
                {register && (
                  <div className="auth-tight">
                    {passwordField}
                    <PasswordRules password={password} />
                    <div className="auth-terms">
                      <input
                        id="auth-terms"
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(e) => setAgreedToTerms(e.target.checked)}
                      />
                      {/* The three underlined words were a <button> with no handler:
                          a control that takes a tab stop, says "button" and then does
                          nothing when it is pressed, because there is no terms page
                          to point it at yet (debt §7). A <span> keeps the frame's
                          underline and stops promising something that is not there.

                          It can then go inside the label, where it belongs: the box
                          is named "I agree to the Terms & Conditions" and not "I
                          agree to the", which is all the label used to say. When the
                          document exists this becomes an <a> and moves back out — a
                          real link inside a label is activated by clicking the label,
                          so the tick would toggle on the way to reading them. */}
                      <label className="auth-terms-text" htmlFor="auth-terms">
                        I agree to the <span className="auth-terms-link">Terms &amp; Conditions</span>
                      </label>
                    </div>
                  </div>
                )}

                {register && inviteRequired && (
                  <div className="auth-field">
                    <label className="auth-label" htmlFor="auth-invite">
                      Invite code
                    </label>
                    <input
                      id="auth-invite"
                      className="auth-input"
                      required
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                    />
                  </div>
                )}

                {feedback && <Message feedback={feedback} />}

                {/* neither half of this row means anything on the other two screens */}
                {login && (
                  <div className="auth-row">
                    <label className="auth-check">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                      />
                      Remember me
                    </label>
                    {/* it opens the frame's screen; what that screen cannot do when
                        its button is pressed is debt §1 */}
                    <button
                      className="auth-muted-link"
                      type="button"
                      onClick={() => goTo('forgot')}
                      disabled={busy}
                    >
                      Forgot password?
                    </button>
                  </div>
                )}

                {/* The ellipsis is appended rather than substituted: on its own it
                    was the button's entire accessible name for as long as the
                    request was out, so the one control on the screen stopped saying
                    what it does at the one moment somebody might ask. */}
                <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy}>
                  {busy ? `${words.action}…` : words.action}
                </button>
              </form>
            )}

            {/* Forgot Password takes register's footer, which is the frame's own:
                somebody who arrived here from the login screen is going back to it.
                Password Changed! has none — its button is already the way out */}
            {!done && (
              <p className="auth-foot">
                {login ? 'Don’t have an account?' : 'Already have account?'}{' '}
                {/* disabled while a request is out: switching mid-flight lets the
                    answer land and paint a sentence about the screen just left */}
                <button
                  type="button"
                  onClick={() => goTo(login ? 'register' : 'login')}
                  disabled={busy}
                >
                  {login ? 'Sign up here' : 'Sign in here'}
                </button>
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
