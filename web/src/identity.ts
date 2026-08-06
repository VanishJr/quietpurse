/**
 * The letter that stands where a product with photographs would put a photograph.
 *
 * The surname's first, or the address's when there is no name to take one from. No
 * photograph is asked for anywhere in this product, and a placeholder silhouette says
 * less than a letter does.
 *
 * Its own module because two screens draw it — the Overview's header and the Account
 * screen's identity block — and a second copy would be a second answer for anyone
 * whose name is one word.
 *
 * The parameter is the shape and not `SessionUser`, so this stays a module a node
 * test can import without pulling api.ts and its environment in behind it.
 */
export function initialOf(user: { name?: string; email: string }): string {
  const name = user.name?.trim() ?? '';
  if (name) {
    const parts = name.split(/\s+/);
    return parts[parts.length - 1].charAt(0).toUpperCase();
  }
  return user.email.charAt(0).toUpperCase();
}
