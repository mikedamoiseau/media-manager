// The Extra channels: French-language channels from outside iptv-org's lists, picked by hand because they play
// well from far away (Samsung TV Plus serves them from nearby edges). Their guide: Samsung TV Plus's, read
// from the id in the address (see guideCandidates), or the first source's under their key.
import type { M3uEntry } from './iptv.ts';

const LOGOS = 'https://tvpnlogopeu.samsungcloud.tv/platform/image/sourcelogo/vc/00/02/34';

/** A Samsung TV Plus France channel, through jmp2.uk (it hands out the current address). */
const samsung = (id: string, name: string, group: string, logo: string): M3uEntry => ({
  key: `${id}.stvp`, name, logo: `${LOGOS}/${id}_${logo}SQUARE.png`, group, opts: [], url: `https://jmp2.uk/stvp-${id}`,
});

export const EXTRA_CHANNELS: M3uEntry[] = [
  samsung('FRBD2300002CM', 'Les Lapins Crétins', 'Kids', '20260224T030940'),
  samsung('FR700001VJ', 'Pocoyo', 'Kids', '20251111T012101'),
  samsung('FR2200004HP', 'Masha et Michka', 'Kids', '20260721T035836'),
  samsung('FR1600002TT', 'Les Télétubbies', 'Kids', '20260721T035906'),
  samsung('FRBD1900012T7', 'Charlotte aux Fraises', 'Kids', '20260901T054432'),
  samsung('FR2100002YW', 'Pingu', 'Kids', '20260901T054517'),
  samsung('FR2600010LM', "C'est pas sorcier", 'Kids', '20260929T041436'),
  samsung('FRBD37000020Y', 'Plus belle la vie', 'Series', '20261006T034046'),
  samsung('FR3600001R1', 'Un si grand soleil', 'Series', '20260707T051816'),
  {
    key: 'I24news.fr@SD', name: 'i24NEWS', group: 'News', opts: [], url: 'https://i24newsfrench-cdn.encoders.immergo.tv/master.m3u8',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/79/LOGO_i24NEWS.png/960px-LOGO_i24NEWS.png',
  },
  samsung('FR300005WY', 'RMC Talk Info', 'News', '20241015T042807'),
  {
    key: 'AfricanewsFrench.fr@SD', name: 'Africanews', group: 'News', opts: [], url: 'https://cdn-euronews.akamaized.net/live/eds/africanews-fr/25050/index.m3u8',
    logo: 'https://i.imgur.com/5UxU4zc.png',
  },
  {
    key: 'TV5MONDEChefs.fr@SD', name: 'TV5MONDE Chefs', group: 'Lifestyle', opts: [], url: 'https://tvf-tv5ch.otteravision.com/tvf/tv5ch/tv5ch.m3u8',
    logo: 'https://psi.tv5monde.com/media/static/default/lives/tv5monde-chef.png',
  },
  samsung('FR4200001BN', 'La Maison France 5', 'Lifestyle', '20260528T055238'),
  samsung('FRBC4000001IO', 'Destination Nature', 'Documentary', '20260818T050804'),
  samsung('FR300004J5', 'BFM Grands Reportages', 'Documentary', '20241015T040221'),
  samsung('FR1100002RF', 'After Foot TV', 'Sports', '20260622T063925'),
  samsung('FR300003ZB', 'RMC Mécanic', 'Sports', '20241015T042802'),
];
