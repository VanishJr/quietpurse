/**
 * Plain rule-based categorization: MCC first, then keywords in the description,
 * otherwise "other". No ML — that's a deliberate choice for now.
 *
 * The rules depend on the sign of the amount: income has its own set of categories
 * (salary, cashback, transfers). Refunds are the exception ("Скасування. Bolt"):
 * they arrive as a positive amount but are categorized by merchant (transport), so
 * that they subtract from spending in that category instead of counting as income.
 *
 * Bump RULES_VERSION when the rules change — the backend recategorizes the whole
 * database on startup (see classify.ts).
 *
 * Merchant keywords are matched against raw bank descriptions, so the Ukrainian,
 * Russian and German spellings below are data, not prose — they must not be
 * "translated". Ukrainian banks emit statements in both Ukrainian and Russian.
 */

export const RULES_VERSION = 8;

export const CATEGORIES = [
  'housing',
  'food',
  'transport',
  'subscriptions',
  'entertainment',
  'health',
  'shopping',
  'cash',
  'transfers',
  'salary',
  'cashback',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

const MCC_MAP: Record<number, Category> = {};

function addMcc(category: Category, codes: number[]): void {
  for (const c of codes) MCC_MAP[c] = category;
}

// Food: supermarkets, groceries, restaurants, fast food, delivery
addMcc('food', [5411, 5422, 5441, 5451, 5462, 5499, 5921, 5811, 5812, 5813, 5814]);
// Transport: public transit, taxi, rail, fuel, parking, car rental, air
addMcc('transport', [
  4011, 4111, 4112, 4121, 4131, 4511, 4582, 4722, 4784, 4789,
  5541, 5542, 5983, 7511, 7512, 7523,
]);
// Subscriptions: telecom/streaming billing, digital goods, apps
addMcc('subscriptions', [4814, 4899, 5815, 5816, 5817, 5818, 5968, 7372]);
// Entertainment: cinema, theatre, concerts, games, sports
addMcc('entertainment', [
  7829, 7832, 7841, 7911, 7922, 7929, 7932, 7933, 7941, 7991, 7992, 7993,
  7994, 7996, 7997, 7998, 7999,
]);
// Health: pharmacies, doctors, clinics
addMcc('health', [
  5122, 5912, 8011, 8021, 8031, 8041, 8042, 8043, 8049, 8050, 8062, 8071, 8099,
]);
// Shopping: department stores, clothing, electronics, household goods
addMcc('shopping', [
  5200, 5300, 5311, 5331, 5399, 5611, 5621, 5631, 5641, 5651, 5655, 5661,
  5691, 5699, 5722, 5732, 5733, 5735, 5941, 5942, 5943, 5945, 5946, 5947,
  5948, 5949, 5977, 5999,
]);
// Cash: ATMs
addMcc('cash', [6010, 6011]);
// Transfers: p2p, money transfer (6536/6537 — incoming p2p in Monobank)
addMcc('transfers', [4829, 6012, 6536, 6537, 6538, 6540]);

/**
 * Keywords: the first match wins, so the more specific ones ("bolt food") come
 * before the general ones ("bolt").
 */
const KEYWORD_RULES: [string, Category][] = [
  // housing: rent
  ['miete', 'housing'],
  ['wohnung', 'housing'],
  // subscriptions / digital services
  ['netflix', 'subscriptions'],
  ['spotify', 'subscriptions'],
  ['youtube', 'subscriptions'],
  ['apple.com/bill', 'subscriptions'],
  ['apple music', 'subscriptions'],
  ['icloud', 'subscriptions'],
  ['google one', 'subscriptions'],
  ['google storage', 'subscriptions'],
  ['openai', 'subscriptions'],
  ['chatgpt', 'subscriptions'],
  ['anthropic', 'subscriptions'],
  ['github', 'subscriptions'],
  ['notion', 'subscriptions'],
  ['patreon', 'subscriptions'],
  ['megogo', 'subscriptions'],
  ['telegram premium', 'subscriptions'],
  ['vodafone', 'subscriptions'],
  ['n26 business', 'subscriptions'],
  ['colab', 'subscriptions'],
  ['whoop', 'subscriptions'],
  // "Uber *one Membership" — before the general "uber" (that one is in transport)
  ['one membership', 'subscriptions'],
  // food: delivery and eating out (before the general "bolt")
  ['bolt food', 'food'],
  ['glovo', 'food'],
  ['wolt', 'food'],
  ['mcdonald', 'food'],
  ['kfc', 'food'],
  ['pizza', 'food'],
  ['sushi', 'food'],
  ['coffee', 'food'],
  ['кафе', 'food'],
  ['кава', 'food'],
  ['ресторан', 'food'],
  ['restaurant', 'food'],
  ['baeckerei', 'food'],
  ['bäckerei', 'food'],
  ['espresso house', 'food'],
  ['le crobag', 'food'],
  // food: supermarkets (UA + EU)
  ['сільпо', 'food'],
  ['silpo', 'food'],
  ['атб', 'food'],
  ['atb', 'food'],
  ['novus', 'food'],
  ['varus', 'food'],
  ['ашан', 'food'],
  ['auchan', 'food'],
  ['fora', 'food'],
  ['lidl', 'food'],
  ['aldi', 'food'],
  ['rewe', 'food'],
  ['edeka', 'food'],
  ['netto', 'food'],
  ['penny', 'food'],
  ['biedronka', 'food'],
  ['zabka', 'food'],
  ['żabka', 'food'],
  ['carrefour', 'food'],
  ['tesco', 'food'],
  // "Kaufland Marketplace" is an online marketplace, not a supermarket (order matters)
  ['kaufland marketplace', 'shopping'],
  ['kaufland', 'food'],
  ['grocer', 'food'],
  ['supermarket', 'food'],
  // transport
  ['riverty', 'transport'], // Www.riverty.com*bvg — BVG tickets
  ['bvg', 'transport'],
  ['db vertrieb', 'transport'],
  ['uber', 'transport'],
  ['uklon', 'transport'],
  ['bolt', 'transport'],
  ['taxi', 'transport'],
  ['таксі', 'transport'],
  ['такси', 'transport'],
  ['укрзализныця', 'transport'],
  ['укрзалізниця', 'transport'],
  ['railway', 'transport'],
  ['deutsche bahn', 'transport'],
  ['flixbus', 'transport'],
  ['ryanair', 'transport'],
  ['wizz', 'transport'],
  ['wog', 'transport'],
  ['okko', 'transport'],
  ['shell', 'transport'],
  ['fuel', 'transport'],
  ['parking', 'transport'],
  ['паркінг', 'transport'],
  ['паркинг', 'transport'],
  ['metro ', 'transport'],
  // entertainment
  ['steam', 'entertainment'],
  ['playstation', 'entertainment'],
  ['xbox', 'entertainment'],
  ['nintendo', 'entertainment'],
  ['cinema', 'entertainment'],
  ['кіно', 'entertainment'],
  ['кино', 'entertainment'],
  ['concert', 'entertainment'],
  ['концерт', 'entertainment'],
  ['faceit', 'entertainment'],
  ['vivenu', 'entertainment'], // event ticketing
  // health
  ['rsg group', 'health'], // gym chain (McFIT and others)
  ['аптека', 'health'],
  ['apteka', 'health'],
  ['pharmacy', 'health'],
  ['clinic', 'health'],
  ['клініка', 'health'],
  ['клиника', 'health'],
  // shopping: marketplaces and electronics (Enable Banking often omits the MCC)
  ['amazon', 'shopping'],
  ['amzn', 'shopping'],
  ['galaxus', 'shopping'],
  ['cyberport', 'shopping'],
  ['intersport', 'shopping'],
  ['microsoft', 'shopping'],
  ['miele', 'shopping'],
  // cash and transfers
  ['банкомат', 'cash'],
  ['atm', 'cash'],
  ['cash withdrawal', 'cash'],
  ['cash at', 'cash'], // "Cash at Vrb Musterbank eG" — ATM withdrawal (Enable Banking)
  ['переказ', 'transfers'],
  ['перевод', 'transfers'],
  ['transfer', 'transfers'],
  ['revolut user', 'transfers'],
  ['p2p', 'transfers'],
];

/**
 * Refund / cancelled purchase: arrives as a positive amount, but it isn't income —
 * it's a reversed expense. Monobank writes "Скасування. <merchant>", Enable Banking
 * uses refund/reversal.
 */
const REFUND_MARKERS = ['скасування', 'refund', 'reversal', 'chargeback'];

export function isRefund(amount: number, description: string): boolean {
  if (amount <= 0) return false;
  const d = (description || '').toLowerCase();
  return REFUND_MARKERS.some((m) => d.includes(m));
}

/**
 * Grouping key for recurring payments: case-insensitive, digits collapsed to "#".
 * Otherwise a rent line "REF 1234+0078 LEV 01/2026" and "... LEV 02/2026" look like
 * two different payments, and the largest recurring expense is never found at all.
 */
export function recurringKey(description: string): string {
  return description.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
}

/** Income-only rules (refunds excluded — those are categorized as spending). */
const INCOME_KEYWORD_RULES: [string, Category][] = [
  ['заробітної плати', 'salary'],
  ['заробітна плата', 'salary'],
  ['зарплат', 'salary'],
  ['salary', 'salary'],
  ['payroll', 'salary'],
  // German payslips: "Lohn/Gehalt August 2025", "LOHN / GEHALT   01/26"
  ['lohn', 'salary'],
  ['gehalt', 'salary'],
  ['кешбек', 'cashback'],
  ['кешбэк', 'cashback'],
  ['кэшбек', 'cashback'],
  ['cashback', 'cashback'],
  ['від:', 'transfers'],
  ['от:', 'transfers'],
  ['from:', 'transfers'],
];

const INCOME_MCC: Record<number, Category> = {
  4829: 'transfers',
  6012: 'transfers',
  6536: 'transfers',
  6537: 'transfers',
  6538: 'transfers',
  6540: 'transfers',
};

/**
 * @param amount signed amount; if omitted — spending rules (backwards compatibility
 *   with older callers).
 */
export function categorize(
  mcc: number | undefined,
  description: string,
  amount?: number,
): string {
  const d = (description || '').toLowerCase();

  // income, but not a refund — its own set of rules
  if (amount !== undefined && amount > 0 && !isRefund(amount, description)) {
    if (d) {
      for (const [kw, cat] of INCOME_KEYWORD_RULES) {
        if (d.includes(kw)) return cat;
      }
    }
    if (mcc && INCOME_MCC[mcc]) return INCOME_MCC[mcc];
    return 'other';
  }

  if (mcc && MCC_MAP[mcc]) return MCC_MAP[mcc];
  if (d) {
    for (const [kw, cat] of KEYWORD_RULES) {
      if (d.includes(kw)) return cat;
    }
  }
  return 'other';
}
