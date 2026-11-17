/**
 * The script in each site's `<head>` that paints the page in the visitor's look before the first frame: the device's light or
 * dark setting, then a look carried in the link. It reads the link once, ignores any value it does not know, removes the
 * look's parameters from the address so a reload starts from the default, and stores nothing: the look lives in attributes
 * on the root element for as long as the page stays open. It runs under a Content-Security-Policy with no `script-src`;
 * `tests/head-script.spec.ts` fails if a site's headers start restricting inline scripts.
 *
 * @module @delorun/site-design/head-script
 */
import { KNOWN_ACCENTS, KNOWN_CONTRASTS, KNOWN_DENSITIES, KNOWN_LOOKS, KNOWN_SCHEMES, LOOK_PARAMS } from './looks.ts'

/** The id the build keeps when it strips the router's scripts from the not-found page. */
export const LOOK_SCRIPT_ID = 'theme-init'

/** The script text. Its lists are the ones in `looks.ts`, so the two cannot differ. */
export const LOOK_SCRIPT = `(function(){var d=document.documentElement,m=matchMedia('(prefers-color-scheme: dark)'),fixed=false;function a(){if(!fixed)d.classList.toggle('dark',m.matches)}a();m.addEventListener('change',a);var u=new URL(location.href),p=u.searchParams,P=${JSON.stringify(LOOK_PARAMS)};if(!P.some(function(n){return p.has(n)}))return;function k(l,v){return l.indexOf(v)<0?null:v}var l=k(${JSON.stringify(KNOWN_LOOKS)},p.get('look'))||'soft',s=k(${JSON.stringify(KNOWN_SCHEMES)},p.get('scheme'));d.dataset.look=l;if(l==='custom'){d.dataset.accent=k(${JSON.stringify(KNOWN_ACCENTS)},p.get('accent'))||'peach';d.dataset.contrast=k(${JSON.stringify(KNOWN_CONTRASTS)},p.get('contrast'))||'default'}else d.dataset.contrast='default';d.dataset.density=k(${JSON.stringify(KNOWN_DENSITIES)},p.get('density'))||'comfortable';if(s){fixed=true;d.classList.toggle('dark',s==='dark')}P.forEach(function(n){p.delete(n)});history.replaceState(history.state,'',u.pathname+u.search+u.hash)})()`
