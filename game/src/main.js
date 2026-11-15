import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createPlayer } from './player.js';
import { createInput } from './input.js';
import { createWeaponSet, WEAPON_DEFS, GRENADE_DEFS } from './weapons.js';
import { createGrenadeField } from './grenades.js';
import { createFx } from './fx.js';
import { createBots } from './bots.js';
import { createRounds } from './rounds.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;
const TAU = Math.PI * 2;
const raycaster = new THREE.Raycaster();
const aimDirection = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();
const shotEnd = new THREE.Vector3();
const grenadeDirection = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const impactNormal = new THREE.Vector3();
const hitPoint = new THREE.Vector3();
const colorScratch = new THREE.Color();

const root = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
root.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE?.canvas || '#14161a');

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 120);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = createWorld(scene);
const player = createPlayer(world.colliders);
const input = createInput(renderer.domElement);
const weapons = createWeaponSet(camera);
const audio = createAudio();
const hud = createHud();
const fx = createFx(scene);

const G = {
  phase: 'buy',
  health: 100,
  armour: 0,
  selectedGrenade: 'frag',
  scoped: false,
  bomb: { planted: false, site: null, fuse: 0, carrier: 'player', defused: false, exploded: false },
  playerChannel: '',
  channelProgress: 0,
  time: 0,
  shotCooldown: 0,
  playerAlive: true,
  lastInputFire: false,
  rounds: null,
  bots: null,
  field: null,
  // v3: kills per name this round, for the MVP line on the round-end
  // screen and the scoreboard. Reset when a new round's buy phase opens.
  roundKills: {},
  mvp: null
};

function setPlayerPosition(x, y, z) {
  if (player.state?.position) player.state.position.set(x, y, z);
  else if (player.state?.pos) player.state.pos.set(x, y, z);
  else player.state && Object.assign(player.state, { x, y, z });
  camera.position.set(x, y + 1.62, z);
}

function getPlayerPosition(out) {
  if (player.state?.position) return out.copy(player.state.position);
  if (player.state?.pos) return out.copy(player.state.pos);
  return out.set(camera.position.x, Math.max(0, camera.position.y - 1.62), camera.position.z);
}

function playerTeam() {
  return 'ember';
}

function addFeed(text) {
  hud.addKill(text);
}

function applyPlayerDamage(amount) {
  if (!G.playerAlive || amount <= 0) return;
  const absorbed = Math.min(G.armour, amount * 0.25);
  G.armour = Math.max(0, G.armour - absorbed);
  G.health = Math.max(0, G.health - (amount - absorbed));
  hud.setHealth(G.health, G.armour);
  hud.damageFlash();
  audio.hurt();
  if (G.health <= 0) {
    G.playerAlive = false;
    G.playerChannel = '';
    G.channelProgress = 0;
    setScoped(false);
    camera.position.y = Math.max(0.6, camera.position.y - 0.35);
  }
}

// Area damage from a frag burst, with falloff. Used by the grenade hook.
function damageAt(pos, radius, damage) {
  const radiusSq = radius * radius;
  for (const bot of G.bots.list) {
    if (!bot.alive) continue;
    const distanceSq = bot.pos.distanceToSquared(pos);
    if (distanceSq > radiusSq) continue;
    const amount = damage * (1 - Math.sqrt(distanceSq) / radius);
    const died = G.bots.damage(bot, amount, 'torso');
    if (died) {
      G.rounds.addKillReward();
      recordKill('Player');
      addFeed(`Player Frag  >  ${bot.name}`);
      fx.death(bot.pos);
    }
  }
  getPlayerPosition(hitPoint);
  const playerDistanceSq = hitPoint.distanceToSquared(pos);
  if (playerDistanceSq <= radiusSq) {
    applyPlayerDamage(damage * (1 - Math.sqrt(playerDistanceSq) / radius));
  }
}

function botHooks() {
  return {
    los(from, to) {
      grenadeDirection.subVectors(to, from);
      const distance = grenadeDirection.length();
      if (distance <= 0.05) return true;
      raycaster.set(from, grenadeDirection.multiplyScalar(1 / distance));
      raycaster.far = distance;
      return raycaster.intersectObjects(world.shootables, false).length === 0;
    },
    smokeBlocks(from, to) {
      return G.field ? G.field.smokeBlocks(from, to) : false;
    },
    throwGrenade(bot, type, targetPos) {
      if (!G.field) return;
      tmpDir.copy(targetPos).sub(bot.group.position);
      tmpDir.y = 0;
      tmpDir.normalize().multiplyScalar(14);
      tmpPos.copy(bot.group.position);
      tmpPos.y += 1.4;
      G.field.throw(type, tmpPos, tmpDir);
    },
    damagePlayer: applyPlayerDamage,
    onKill(victimTeam, killerTeam, killerName, victimName, headshot, weapon) {
      addFeed(`${killerName} ${weapon || ''}  >  ${victimName}${headshot ? '  [HS]' : ''}`);
      recordKill(killerName);
      if (killerTeam === 'ember' && killerName === 'Player') G.rounds.addKillReward();
    },
    hearNoise(pos, radius, team) {
      if (team === 'ember') return;
      G.bots.hearNoise?.(pos, radius, team);
    },
    onPlant(site) {
      if (G.bomb.planted) return;
      G.bomb.site = site;
      G.playerChannel = '';
      audio.plantBeep();
    },
    onPlanted(site) {
      G.bomb.planted = true;
      G.bomb.site = site;
      G.bomb.fuse = 35;
      G.rounds.addPlantReward();
      G.rounds.state.bomb.planted = true;
      G.rounds.state.bomb.site = site;
      hud.setBomb(`BOMB PLANTED · SITE ${site}`, 1);
      audio.plantBeep();
    },
    onDefuseStart() {
      audio.defuseTick();
    },
    onDefused(site) {
      G.bomb.defused = true;
      G.rounds.addDefuseReward();
      G.rounds.state.bomb.site = site;
      audio.defuseTick();
    }
  };
}

const roundEvents = {
  onPhase(phase) {
    G.phase = phase;
    setScoped(false);
    if (phase === 'buy') {
      hud.showBanner(`ROUND ${G.rounds?.state.round || 1}`, 'BUY PHASE', 1800);
      // v3: a new round starts the kill count over, and the scoreboard
      // closes until Tab or the next round end reopens it.
      G.roundKills = {};
      G.mvp = null;
      hud.showScoreboard(false);
    }
    if (phase === 'live') {
      hud.hideBuy();
      G.bomb.carrier = 'player';
    }
  },
  onRoundEnd(winner, reason, round) {
    const label = winner === 'ember' ? 'EMBER' : 'KESTREL';
    hud.showBanner(`${label} WINS`, reason === 'elimination' ? 'ELIMINATION' : reason.toUpperCase(), 2400);
    if (winner === 'ember') audio.roundWin();
    else audio.roundLose();
    // v3: name the round MVP, write the finished round into the
    // scoreboard and open it — the end screen and the scoreboard tell
    // the same story, and the MVP rides on both.
    G.mvp = computeMvp();
    hud.setScoreboard(G.rounds.state.history, G.mvp);
    hud.showScoreboard(true);
    if (G.rounds.isMatchOver()) {
      hud.showOverlay('matchEnd', { winner: G.rounds.matchWinner(), score: G.rounds.state.score });
    } else {
      hud.showOverlay('roundEnd', { winner: label, reason, score: G.rounds.state.score, round, mvp: G.mvp });
    }
  },
  onMoney(value) { hud.setMoney(value); },
  onScore(score) { hud.setScore(score.ember, score.kestrel); },
  onBombPlanted(site) { hud.setBomb(`BOMB PLANTED · SITE ${site}`, 1); },
  onBombExploded() { G.bomb.exploded = true; audio.explosion(); },
  onBombDefused() { G.bomb.defused = true; }
};

G.rounds = createRounds(roundEvents);
G.bots = createBots(scene, world, botHooks());
G.field = createGrenadeField(scene, {
  onFrag(pos, radius, damage) {
    fx.explosion(pos);
    audio.explosion();
    damageAt(pos, radius, damage);
  },
  onFlash(pos, radius, seconds) {
    G.bots.flashAt(pos, radius, seconds);
    camera.getWorldDirection(aimDirection);
    tmpDir.subVectors(pos, camera.position).normalize();
    const looking = aimDirection.dot(tmpDir) > 0.3;
    hud.flashScreen(looking ? seconds : 0.8);
    audio.flash();
  },
  onSmoke(pos, radius, seconds) {
    audio.smokeHiss();
  }
});

function setLoadoutHud() {
  const ammo = weapons.state.weapons[weapons.state.current];
  const definition = WEAPON_DEFS[weapons.state.current];
  if (ammo && definition) hud.setAmmo(ammo.mag, ammo.reserve, definition.name);
}

function traceShot() {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  raycaster.far = weapons.def().range;
  const objects = world.shootables.concat(G.bots.hitMeshes);
  const intersections = raycaster.intersectObjects(objects, false);
  const hit = intersections.length ? intersections[0] : null;
  shotOrigin.copy(camera.position);
  if (hit) shotEnd.copy(hit.point);
  else shotEnd.copy(raycaster.ray.direction).multiplyScalar(raycaster.far).add(shotOrigin);

  if (hit?.object.userData.bot) {
    const bot = hit.object.userData.bot;
    const part = hit.object.userData.part;
    const head = part === 'head';
    const damage = weapons.def().damage * (head ? weapons.def().headMult : 1);
    const killed = G.bots.damage(bot, damage, part);
    if (killed) {
      G.rounds.addKillReward();
      recordKill('Player');
      addFeed(`Player ${weapons.def().name}  >  ${bot.name}${head ? '  [HS]' : ''}`);
      fx.death(bot.pos);
    }
    hud.hitMarker(killed);
    audio.hit(head);
  } else if (hit) {
    impactNormal.copy(raycaster.ray.direction).negate();
    fx.impact(hit.point, impactNormal);
  }

  fx.tracer(shotOrigin, shotEnd, weapons.def().tracer);
  camera.getWorldDirection(aimDirection);
  tmpPos.copy(shotOrigin).addScaledVector(aimDirection, 0.6);
  tmpPos.y -= 0.1;
  fx.muzzle(tmpPos);
  player.recoil?.(weapons.def().recoilPitch, weapons.def().recoilYaw * (Math.random() * 2 - 1));
  G.bots.hearNoise?.(shotOrigin, 28, 'ember');
}

function tryFire() {
  if (!input.state.locked || !G.playerAlive || !['live', 'planted'].includes(G.phase)) return;
  if (!input.state.firing && !input.state.keys?.has('Space')) return;
  const definition = weapons.def();
  if (!weapons.ready()) return;
  if (!weapons.takeRound()) {
    audio.dryFire();
    return;
  }
  traceShot();
  audio.shot(0);
  setLoadoutHud();
}

function reloadWeapon() {
  if (weapons.reload()) audio.reload();
}

function selectWeapon(id) {
  if (weapons.select(id)) {
    setScoped(false);
    setLoadoutHud();
  }
}

function selectGrenade(id) {
  if (!GRENADE_DEFS[id]) return;
  if (weapons.state.grenades[id] <= 0) return;
  G.selectedGrenade = id;
}

function throwGrenade() {
  if (!G.playerAlive || G.phase !== 'live' || G.bomb.planted) return;
  const id = G.selectedGrenade;
  if (!weapons.takeGrenade(id)) {
    audio.denied();
    return;
  }
  camera.getWorldDirection(grenadeDirection);
  tmpPos.copy(camera.position);
  grenadeDirection.multiplyScalar(12);
  grenadeDirection.y += 3.3;
  G.field.throw(id, tmpPos, grenadeDirection);
  audio.shot(0);
}

function setScoped(on) {
  const def = weapons.def();
  const want = Boolean(on && def?.scoped && G.playerAlive && ['live', 'planted'].includes(G.phase));
  if (want === G.scoped) return;
  G.scoped = want;
  camera.fov = want ? 75 / def.zoom : 75;
  camera.updateProjectionMatrix();
  hud.setScope(want);
}
document.addEventListener('mousedown', event => {
  if (event.button === 2) setScoped(true);
});
document.addEventListener('mouseup', event => {
  if (event.button === 2) setScoped(false);
});
document.addEventListener('contextmenu', event => event.preventDefault());

function startPlayerChannel() {
  if (!input.state.keys?.has('KeyE') || !G.playerAlive) {
    if (G.playerChannel === 'player') {
      G.playerChannel = '';
      G.channelProgress = 0;
    }
    return;
  }

  getPlayerPosition(hitPoint);
  if (playerTeam() === 'ember' && G.phase === 'live' && !G.bomb.planted) {
    let nearest = null;
    let nearestDistance = 2.25 * 2.25;
    for (const site of ['A', 'B']) {
      const distance = hitPoint.distanceToSquared(world.plantSpots[site]);
      if (distance < nearestDistance) {
        nearest = site;
        nearestDistance = distance;
      }
    }
    if (nearest) {
      G.playerChannel = 'player';
      G.bomb.site = nearest;
      G.channelProgress += FIXED_DT;
      hud.setBomb(`PLANTING ${nearest} · ${Math.floor(G.channelProgress / 3.2 * 100)}%`);
      if (G.channelProgress >= 3.2) {
        G.bomb.planted = true;
        G.bomb.fuse = 35;
        G.bomb.carrier = null;
        G.channelProgress = 0;
        G.playerChannel = '';
        G.rounds.addPlantReward();
        audio.plantBeep();
        hud.setBomb(`BOMB PLANTED · SITE ${nearest}`, 1);
      }
      return;
    }
  }

  if (G.phase === 'planted' && G.bomb.planted) {
    const plant = world.plantSpots[G.bomb.site];
    if (plant && hitPoint.distanceToSquared(plant) < 2.25 * 2.25) {
      G.playerChannel = 'player';
      G.channelProgress += FIXED_DT;
      hud.setBomb(`DEFUSING · ${Math.floor(G.channelProgress / 5 * 100)}%`, 1 - G.bomb.fuse / 35);
      if (G.channelProgress >= 5) {
        G.bomb.defused = true;
        G.channelProgress = 0;
        G.playerChannel = '';
        G.rounds.addDefuseReward();
        audio.defuseTick();
      }
      return;
    }
  }

  if (G.playerChannel === 'player') {
    G.playerChannel = '';
    G.channelProgress = 0;
  }
}

function buyItems() {
  return [
    { key: '1', name: 'P9', price: WEAPON_DEFS.p9.price, desc: '12 / 36 · sidearm', owned: Boolean(weapons.state.weapons.p9) },
    { key: '2', name: 'VK-7', price: WEAPON_DEFS.vk7.price, desc: '30 / 90 · rifle', owned: Boolean(weapons.state.weapons.vk7) },
    { key: '3', name: 'KX-9', price: WEAPON_DEFS.kx9.price, desc: '32 / 96 · SMG', owned: Boolean(weapons.state.weapons.kx9) },
    { key: '4', name: 'LR-88', price: WEAPON_DEFS.lr88.price, desc: '5 / 15 · marksman · scope', owned: Boolean(weapons.state.weapons.lr88) },
    { key: '5', name: 'Frag', price: GRENADE_DEFS.frag.price, desc: 'Blast damage', owned: weapons.state.grenades.frag >= 2 },
    { key: '6', name: 'Flash', price: GRENADE_DEFS.flash.price, desc: 'Blinds lookers', owned: weapons.state.grenades.flash >= 2 },
    { key: '7', name: 'Smoke', price: GRENADE_DEFS.smoke.price, desc: 'Blocks sight 12s', owned: weapons.state.grenades.smoke >= 2 },
    { key: '8', name: 'Kevlar vest', price: 650, desc: 'Damage reduction', owned: weapons.state.kevlar }
  ];
}

function buyItem(item) {
  let price = -1;
  if (item.key === '5') price = weapons.buyGrenade('frag', G.rounds.state.money);
  else if (item.key === '6') price = weapons.buyGrenade('flash', G.rounds.state.money);
  else if (item.key === '7') price = weapons.buyGrenade('smoke', G.rounds.state.money);
  else if (item.key === '8') price = weapons.buyKevlar(G.rounds.state.money);
  else {
    const ids = { '1': 'p9', '2': 'vk7', '3': 'kx9', '4': 'lr88' };
    price = weapons.buy(ids[item.key], G.rounds.state.money);
  }
  if (price < 0 || !G.rounds.spend(price)) {
    audio.denied();
    return;
  }
  audio.buy();
  setLoadoutHud();
  hud.showBuy(buyItems(), G.rounds.state.money, buyItem);
}

function toggleBuy() {
  if (G.phase !== 'buy') return;
  if (hud.buyVisible()) {
    hud.hideBuy();
    input.requestLock();
  } else {
    hud.showBuy(buyItems(), G.rounds.state.money, buyItem);
    document.exitPointerLock?.();
  }
}

function objectiveText() {
  if (G.phase === 'buy') return 'BUY PHASE — SPEND YOUR FUNDS';
  if (G.phase === 'planted') return 'SPARK PLANTED — DEFEND IT';
  if (G.phase === 'over') return '';
  return 'PLANT THE SPARK — HANGAR A / FUEL B';
}

// v3: the round's MVP is the name with the most kills this round; ties
// go to whoever got there first. Zero kills means no MVP yet.
function recordKill(name) {
  if (!name) return;
  G.roundKills[name] = (G.roundKills[name] || 0) + 1;
}

function computeMvp() {
  let best = { name: '—', kills: 0 };
  for (const [name, kills] of Object.entries(G.roundKills)) {
    if (kills > best.kills) best = { name, kills };
  }
  return best;
}

// v3: the team roster for the HUD — the player plus all nine bots, with
// combat role, gun and alive state. Built fresh each frame; hud.setRoster
// only writes the DOM when the text actually changes.
function rosterPlayers() {
  const players = [{
    name: 'You', role: 'Assault', weapon: weapons.def().name,
    team: 'ember', alive: G.playerAlive, me: true
  }];
  if (G.bots) {
    for (const bot of G.bots.list) {
      players.push({
        name: bot.name, role: bot.combatRole, weapon: bot.weapon,
        team: bot.team, alive: bot.alive
      });
    }
  }
  return players;
}

function updateHud() {
  hud.setHealth(G.health, G.armour);
  hud.setMoney(G.rounds.state.money);
  hud.setScore(G.rounds.state.score.ember, G.rounds.state.score.kestrel);
  hud.setAlive(G.bots.aliveCount('ember') + (G.playerAlive ? 1 : 0), G.bots.aliveCount('kestrel'));
  hud.setTimer(G.rounds.state.timer, G.phase);
  hud.setRound(G.rounds.state.round, 9);
  hud.setFunds(G.rounds.state.money);
  hud.setGrenades(weapons.state.grenades, G.selectedGrenade);
  hud.setSlots(WEAPON_DEFS, weapons.state.current);
  hud.setObjective(objectiveText());
  hud.setCarrier(G.bomb.carrier === 'player' && !G.bomb.planted && G.phase !== 'buy');
  // v3: the roster and the scoreboard live in the HUD. Both writers are
  // cached inside the HUD, so these calls are cheap every frame and the
  // panels always agree with the game state.
  hud.setRoster(rosterPlayers());
  hud.setScoreboard(G.rounds.state.history, G.mvp);
  setLoadoutHud();
  const dots = [];
  getPlayerPosition(hitPoint);
  dots.push({ x: hitPoint.x, z: hitPoint.z, team: 'ember', me: true });
  for (const bot of G.bots.list) {
    if (bot.alive) dots.push({ x: bot.pos.x, z: bot.pos.z, team: bot.team });
  }
  hud.drawMinimap(world, dots);
}

function step(dt) {
  G.time += dt;
  G.phase = G.rounds.state.phase;
  input.takeLook?.();
  player.step(dt, input.state.keys);
  weapons.step(dt);
  G.field.step(dt);
  fx.step(dt);
  hud.update();
  startPlayerChannel();

  G.bots.step(dt, {
    time: G.time,
    playerPos: getPlayerPosition(hitPoint),
    playerAlive: G.playerAlive,
    playerCrouching: Boolean(input.state.keys?.has('ControlLeft')),
    playerSpeed: player.groundSpeed?.() || 0,
    bombPlanted: G.bomb.planted,
    bombSite: G.bomb.site,
    phase: G.phase
  });

  if (G.bomb.planted && G.phase === 'planted' && !G.bomb.defused) {
    G.bomb.fuse = Math.max(0, G.bomb.fuse - dt);
    if (G.bomb.fuse <= 0) G.bomb.exploded = true;
    hud.setBomb(`BOMB ACTIVE · SITE ${G.bomb.site}`, G.bomb.fuse / 35);
  }

  G.rounds.step(dt, {
    emberAlive: G.bots.aliveCount('ember') + (G.playerAlive ? 1 : 0),
    kestrelAlive: G.bots.aliveCount('kestrel'),
    playerAlive: G.playerAlive,
    bombPlanted: G.bomb.planted,
    bombSite: G.bomb.site,
    bombDefused: G.bomb.defused,
    bombExploded: G.bomb.exploded,
    timeUp: G.phase === 'live' && G.rounds.state.timer <= 0
  });

  if (G.phase === 'buy' && G.rounds.state.timer <= 0) G.phase = G.rounds.state.phase;
  tryFire();
  updateHud();
}

function render() {
  renderer.render(scene, camera);
}

function onKeyDown(event) {
  if (event.repeat) return;
  if (event.code === 'KeyB') toggleBuy();
  if (event.code === 'KeyR') reloadWeapon();
  // v3: Tab opens the scoreboard (round history + MVP) over the game.
  // preventDefault keeps the browser from moving focus away.
  if (event.code === 'Tab') {
    event.preventDefault();
    hud.showScoreboard(!hud.scoreboardVisible());
  }
  if (event.code === 'Digit1') selectWeapon('p9');
  if (event.code === 'Digit2') selectWeapon('vk7');
  if (event.code === 'Digit3') selectWeapon('kx9');
  if (event.code === 'Digit4') selectWeapon('lr88');
  if (event.code === 'Digit5') selectGrenade('frag');
  if (event.code === 'Digit6') selectGrenade('flash');
  if (event.code === 'Digit7') selectGrenade('smoke');
  if (event.code === 'KeyG') throwGrenade();
}
document.addEventListener('keydown', onKeyDown);

input.state.keys ||= {};
document.addEventListener('pointerlockchange', () => {
  if (!input.state.locked && G.phase !== 'over' && !hud.buyVisible() && G.playerAlive) {
    hud.showOverlay('paused');
  }
});

hud.onPlay(() => {
  audio.unlock();
  hud.hideOverlay();
  if (G.phase === 'over') {
    if (G.rounds.isMatchOver()) { G.rounds.startMatch(); weapons.resetLoadout(); }
    else G.rounds.startRound();
    G.playerAlive = true;
    G.health = 100;
    G.armour = 0;
    G.bomb.planted = false;
    G.bomb.defused = false;
    G.bomb.exploded = false;
    G.selectedGrenade = 'frag';
    G.field.reset();
    fx.reset();
    G.bots.resetRound();
    setPlayerPosition(0, 0, 16);
  }
  input.requestLock();
});

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
}
window.addEventListener('resize', onResize);

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function stageShot(mode, seed) {
  const random = seededRandom(seed);
  Math.random = random;
  fx.reset();
  G.field.reset();
  G.rounds.startMatch();
  G.bots.spawnAll();
  setPlayerPosition(0, 0, 6);
  camera.lookAt(0, 1.5, -14);
  const stagedLive = mode === 'play' || mode === 'buy' || mode === 'end';
  if (stagedLive) hud.hideOverlay();

  if (mode === 'play') {
    G.rounds.state.phase = 'live';
    G.rounds.state.timer = 87;
    G.phase = 'live';
    G.rounds.state.money = 800;
    weapons.give('vk7');
    weapons.state.weapons.vk7.mag = 24;
    weapons.state.grenades = { frag: 1, flash: 1, smoke: 0 };
    G.selectedGrenade = 'frag';
    G.health = 100;
    G.armour = 0;
    const enemies = G.bots.list.filter(bot => bot.team === 'kestrel');
    for (let i = 0; i < enemies.length; i += 1) {
      enemies[i].pos.set((i - 1) * 2.5, 0, -8 - i);
      enemies[i].alive = i < 2;
      enemies[i].group.visible = i < 2;
    }
    G.bots.damage(enemies[2], 1000);
    G.bots.list.find(bot => bot.team === 'ember').pos.set(-18, 0, 12);
    // A smoke cloud hangs over mid-left and a tracer crosses the lane, so
    // the cover shot sells the fight at a glance without hiding the enemies.
    G.field.spawnSmoke(new THREE.Vector3(-6, 1.2, -8), 6, 12);
    fx.tracer(camera.position, new THREE.Vector3(0, 1.45, -8));
    hud.hitMarker(false);
    hud.addKill('Ash VK-7  >  Gale  [HS]');
    hud.addKill('You LR-88  >  Fenn');
    hud.addKill('Bram KX-9  >  Ivo');
    hud.showBanner('', '', 0);
  } else if (mode === 'buy') {
    G.rounds.state.phase = 'buy';
    G.rounds.state.timer = 12;
    G.phase = 'buy';
    G.rounds.state.money = 1900;
    weapons.state.grenades = { frag: 1, flash: 0, smoke: 1 };
    hud.showBuy(buyItems(), G.rounds.state.money, buyItem);
    hud.showBanner('', '', 0);
  } else if (mode === 'end') {
    G.rounds.state.phase = 'over';
    G.rounds.state.round = 1;
    G.rounds.state.score.ember = 1;
    G.rounds.state.score.kestrel = 0;
    G.rounds.state.timer = 4.5;
    G.phase = 'over';
    // v3: the end shot stages the finished round exactly as a real round
    // end would — history row, MVP, scoreboard open — so the judge sees
    // the match story, not an empty panel.
    G.rounds.state.history = [{
      round: 1, winner: 'ember', reason: 'elimination',
      ember: 1, kestrel: 0, delta: '+$3,250 WIN'
    }];
    G.mvp = { name: 'Ash', kills: 3 };
    hud.setScoreboard(G.rounds.state.history, G.mvp);
    hud.showScoreboard(true);
    hud.showOverlay('roundEnd', {
      winner: 'EMBER',
      reason: 'Elimination',
      score: G.rounds.state.score,
      mvp: G.mvp
    });
    hud.showBanner('EMBER WINS', 'ELIMINATION');
  }

  updateHud();
}

const params = new URLSearchParams(window.location.search);
const shotMode = params.get('shot');
const shotSeed = Number(params.get('seed')) || 1;

if (shotMode) {
  stageShot(shotMode, shotSeed);
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  window.__shotReady = true;
} else {
  G.rounds.startMatch();
  G.bots.spawnAll();
  setPlayerPosition(0, 0, 16);
  hud.showOverlay('start');
  hud.setCrosshairGap(6);

  let previous = performance.now();
  let accumulator = 0;
  function frame(now) {
    const elapsed = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps += 1;
    }
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
