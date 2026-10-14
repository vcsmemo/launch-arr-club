/* 301 redirect: launch.arr.club -> milestonewins.com (domain migration 2026-10-14).
 * Only triggers on the old hostname; the new domain and pages.dev pass through.
 * Keeps https://launch.arr.club/badges/badge-dark.svg working for VidSizer's footer. */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === 'launch.arr.club') {
    url.hostname = 'milestonewins.com';
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  if (url.hostname === 'www.milestonewins.com') {
    url.hostname = 'milestonewins.com';
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
