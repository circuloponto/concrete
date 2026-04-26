import { useRef, useEffect, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { useStore, MAX_VOICES } from './state'

const SPHERE_RADIUS = 1
const MARKER_RADIUS = 0.06
const DRAW_MIN_STEP = 0.04   // min angular step (chord length on unit sphere) between drawn points
const MAX_LINE_PTS = 2000    // pre-allocated capacity for trajectory + drawing lines

// 3D arc-length helpers
function pathLength3(pts) {
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dy = pts[i].y - pts[i - 1].y
    const dz = pts[i].z - pts[i - 1].z
    len += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  return len
}
function samplePath3(pts, t01) {
  if (!pts || pts.length < 2) return pts?.[0] || { x: 0, y: 0, z: 1 }
  const total = pathLength3(pts)
  if (total < 0.0001) return pts[0]
  let target = (((t01 % 1) + 1) % 1) * total
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x
    const dy = pts[i].y - pts[i - 1].y
    const dz = pts[i].z - pts[i - 1].z
    const seg = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (target <= seg || i === pts.length - 1) {
      const f = seg > 0 ? target / seg : 0
      return { x: pts[i - 1].x + dx * f, y: pts[i - 1].y + dy * f, z: pts[i - 1].z + dz * f }
    }
    target -= seg
  }
  return pts[pts.length - 1]
}

function hexToInt(hex, fallback = 0x00ff9c) {
  if (!hex || typeof hex !== 'string') return fallback
  const m = hex.match(/#?([0-9a-fA-F]{6})/)
  return m ? parseInt(m[1], 16) : fallback
}

// Build a ribbon = THREE.Line drawn as a zigzag (origin, path[0], origin,
// path[1], origin, path[2], ...). The continuous polyline gives the same
// visual as line segments — every other "edge" backtracks along an existing
// spoke. THREE.Line is the same primitive as the working trajectory line.
function makeRibbon(color, _opacity) {
  const geom = new THREE.BufferGeometry()
  const positions = new Float32Array(MAX_LINE_PTS * 2 * 3)
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setDrawRange(0, 0)
  const mat = new THREE.LineBasicMaterial({ color })
  const mesh = new THREE.Line(geom, mat)
  mesh.renderOrder = 7
  return mesh
}

function fillRibbon(ribbon, pts) {
  const positions = ribbon.geometry.attributes.position.array
  const n = Math.min(pts.length, MAX_LINE_PTS)
  for (let i = 0; i < n; i++) {
    positions[i * 6]     = 0
    positions[i * 6 + 1] = 0
    positions[i * 6 + 2] = 0
    positions[i * 6 + 3] = pts[i].x
    positions[i * 6 + 4] = pts[i].y
    positions[i * 6 + 5] = pts[i].z
  }
  ribbon.geometry.attributes.position.needsUpdate = true
  ribbon.geometry.setDrawRange(0, n * 2) // 2 vertices per spoke
  ribbon.geometry.computeBoundingSphere()
}

const VOICE_COLORS = [0x00ff9c, 0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8]

export function DiffusionTab() {
  const { diffusion, setDiffusion, getAudioCtx, getBuffer, addPoolItem, pool, highlight } = useStore()
  const containerRef = useRef(null)
  const [playing, setPlayingState] = useState(() => Array(MAX_VOICES).fill(false))
  const [recording, setRecording] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [drawDepth, setDrawDepth] = useState(1)
  const [captureName, setCaptureName] = useState('binaural')
  const drawingPtsRef = useRef(null)        // [{x,y,z}, ...] world-space, while drawing
  const draggingRef = useRef(null)          // index of voice being dragged
  const drawDepthRef = useRef(drawDepth); drawDepthRef.current = drawDepth

  // ---- audio engine (HRTF panners + capture stream) ----
  const audioRef = useRef(null)
  const ensureAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current
    const ctx = getAudioCtx()
    const mixer = ctx.createGain(); mixer.gain.value = 1
    const msDest = ctx.createMediaStreamDestination()
    mixer.connect(ctx.destination); mixer.connect(msDest)
    const voices = Array.from({ length: MAX_VOICES }, () => {
      const panner = ctx.createPanner()
      panner.panningModel = 'HRTF'
      panner.distanceModel = 'linear'
      panner.refDistance = 1; panner.maxDistance = 50; panner.rolloffFactor = 0.0
      panner.coneInnerAngle = 360; panner.coneOuterAngle = 360; panner.coneOuterGain = 1
      panner.setPosition(0, 0, -1)
      // distGain after the panner gives audible proximity: small magnitude
      // (near origin, the listener) → louder; magnitude 1 (sphere surface)
      // → quieter. rAF tick writes gain.value each frame.
      const distGain = ctx.createGain()
      distGain.gain.value = 1
      panner.connect(distGain)
      distGain.connect(mixer)
      return { panner, distGain, source: null }
    })
    audioRef.current = { ctx, mixer, msDest, voices }
    return audioRef.current
  }, [getAudioCtx])

  useEffect(() => () => {
    if (!audioRef.current) return
    audioRef.current.voices.forEach(v => { if (v.source) try { v.source.stop() } catch {} })
    try { audioRef.current.mixer.disconnect() } catch {}
    audioRef.current = null
  }, [])

  const diffRef = useRef(diffusion); diffRef.current = diffusion

  const playVoice = (i, overridePoolId) => {
    const a = ensureAudio()
    const poolId = overridePoolId || diffRef.current.voices[i]?.poolId
    if (!poolId) return
    const buf = getBuffer(poolId)
    if (!buf) return
    stopVoice(i)
    const src = a.ctx.createBufferSource()
    src.buffer = buf; src.loop = true
    src.connect(a.voices[i].panner); src.start()
    a.voices[i].source = src
    src.onended = () => { a.voices[i].source = null; setPlayingState(p => { const n = [...p]; n[i] = false; return n }) }
    setPlayingState(p => { const n = [...p]; n[i] = true; return n })
  }
  const stopVoice = (i) => {
    if (!audioRef.current) return
    const v = audioRef.current.voices[i]
    if (v.source) { try { v.source.stop() } catch {}; try { v.source.disconnect() } catch {}; v.source = null }
    setPlayingState(p => { const n = [...p]; n[i] = false; return n })
  }
  const playAll = () => diffRef.current.voices.forEach((v, i) => { if (v.poolId) playVoice(i) })
  const stopAll = () => { for (let i = 0; i < MAX_VOICES; i++) stopVoice(i) }

  const recRef = useRef(null)
  const startRecord = () => {
    const a = ensureAudio()
    const rec = new MediaRecorder(a.msDest.stream)
    const chunks = []
    rec.ondataavailable = e => chunks.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunks)
      const buf = await getAudioCtx().decodeAudioData(await blob.arrayBuffer())
      addPoolItem(captureName || `binaural_${Date.now().toString(36)}`, buf, 'diffusion')
    }
    rec.start(); recRef.current = rec; setRecording(true)
  }
  const stopRecord = () => { if (recRef.current) { recRef.current.stop(); recRef.current = null }; setRecording(false) }

  // ---- THREE.js scene ----
  const sceneRef = useRef(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(1.7, 1.3, 2.6)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)
    container.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    // rotating group: sphere mesh + trajectory lines + trajectory voice markers
    const sphereGroup = new THREE.Group()
    scene.add(sphereGroup)

    // Invisible sphere mesh — raycast target only, no rendered surface.
    const sphereGeom = new THREE.SphereGeometry(SPHERE_RADIUS, 48, 32)
    const sphereMat = new THREE.MeshBasicMaterial({ visible: false })
    const sphereMesh = new THREE.Mesh(sphereGeom, sphereMat)
    sphereGroup.add(sphereMesh)

    // Three orthogonal rings (equator + two meridians) provide orientation
    // while the sphere spins, without any filled surface.
    const ringMat = new THREE.LineBasicMaterial({ color: 0x88ffcc, transparent: true, opacity: 0.35 })
    const mkRing = (axis) => {
      const pts = []
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2
        if (axis === 'y')      pts.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)))
        else if (axis === 'x') pts.push(new THREE.Vector3(0, Math.sin(a), Math.cos(a)))
        else                   pts.push(new THREE.Vector3(Math.sin(a), Math.cos(a), 0))
      }
      return new THREE.BufferGeometry().setFromPoints(pts)
    }
    const equatorGeom = mkRing('y')
    const meridianGeom = mkRing('x')
    const meridian2Geom = mkRing('z')
    sphereGroup.add(new THREE.Line(equatorGeom, ringMat))
    sphereGroup.add(new THREE.Line(meridianGeom, ringMat))
    sphereGroup.add(new THREE.Line(meridian2Geom, ringMat))

    // Cardinal intersection dots — the 6 axis points where pairs of rings
    // meet (±X, ±Y, ±Z on the unit sphere). Helps eyeball orientation.
    const dotGeom = new THREE.SphereGeometry(0.025, 12, 8)
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const axes = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    axes.forEach(([x, y, z]) => {
      const m = new THREE.Mesh(dotGeom, dotMat)
      m.position.set(x, y, z)
      sphereGroup.add(m)
    })

    // Depth-target rings — three orthogonal yellow rings parented to scene
    // (don't rotate), scaled each frame by current drawDepth so the user
    // sees the shell where the next pointer click would land. Only visible
    // while Draw mode is on.
    const depthGroup = new THREE.Group()
    const depthMat = new THREE.LineBasicMaterial({ color: 0xffff00 })
    const dEqGeom = mkRing('y')
    const dM1Geom = mkRing('x')
    const dM2Geom = mkRing('z')
    depthGroup.add(new THREE.Line(dEqGeom, depthMat))
    depthGroup.add(new THREE.Line(dM1Geom, depthMat))
    depthGroup.add(new THREE.Line(dM2Geom, depthMat))
    depthGroup.visible = false
    scene.add(depthGroup)

    // listener marker at world origin (does NOT rotate)
    const listenerGeom = new THREE.SphereGeometry(0.05, 16, 12)
    const listenerMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    const listenerMesh = new THREE.Mesh(listenerGeom, listenerMat)
    scene.add(listenerMesh)

    // OrbitControls — user drags empty space to rotate the camera and
    // see/draw on any hemisphere. Auto-disabled while in draw mode.
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.enableZoom = true
    controls.minDistance = 1.6
    controls.maxDistance = 6
    controls.rotateSpeed = 0.7
    controls.zoomSpeed = 0.6
    controls.enableDamping = true
    controls.dampingFactor = 0.12

    sceneRef.current = {
      scene, camera, renderer, sphereGroup, sphereMesh, controls, depthGroup,
      raycaster: new THREE.Raycaster(),
      ndc: new THREE.Vector2(),
      voiceMarkers: [],
      trajectoryLines: [],
      trajectoryRibbons: [],
      drawingLine: null,
      drawingRibbon: null,
      disposers: [
        () => { sphereGeom.dispose(); sphereMat.dispose() },
        () => { equatorGeom.dispose(); meridianGeom.dispose(); meridian2Geom.dispose(); ringMat.dispose() },
        () => { listenerGeom.dispose(); listenerMat.dispose() },
        () => { dotGeom.dispose(); dotMat.dispose() },
        () => { dEqGeom.dispose(); dM1Geom.dispose(); dM2Geom.dispose(); depthMat.dispose() },
        () => controls.dispose(),
      ],
    }

    const resize = () => {
      const w = container.clientWidth || 520
      const h = container.clientHeight || 520
      const size = Math.min(w, h)
      renderer.setSize(size, size, false)
      camera.aspect = 1
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(container)

    return () => {
      ro.disconnect()
      const s = sceneRef.current
      if (s) {
        s.voiceMarkers.forEach(m => { m.geometry?.dispose(); m.material?.dispose() })
        s.trajectoryLines.forEach(l => { l.geometry?.dispose(); l.material?.dispose() })
        s.trajectoryRibbons.forEach(r => { r.geometry?.dispose(); r.material?.dispose() })
        if (s.drawingLine) { s.drawingLine.geometry.dispose(); s.drawingLine.material.dispose() }
        if (s.drawingRibbon) { s.drawingRibbon.geometry.dispose(); s.drawingRibbon.material.dispose() }
        s.disposers.forEach(fn => { try { fn() } catch {} })
        s.renderer.dispose()
      }
      try { container.removeChild(renderer.domElement) } catch {}
      sceneRef.current = null
    }
  }, [])

  // ---- sync THREE objects when state changes ----
  useEffect(() => {
    const s = sceneRef.current
    if (!s) return
    const hl = hexToInt(highlight)

    // ensure marker count
    while (s.voiceMarkers.length < MAX_VOICES) {
      const i = s.voiceMarkers.length
      const geom = new THREE.SphereGeometry(MARKER_RADIUS, 14, 10)
      const mat = new THREE.MeshBasicMaterial({ color: VOICE_COLORS[i % VOICE_COLORS.length], depthTest: false })
      const mesh = new THREE.Mesh(geom, mat)
      mesh.renderOrder = 10
      mesh.visible = false
      s.scene.add(mesh)
      s.voiceMarkers.push(mesh)
    }

    // All voice markers live in scene (world space). Trajectory voices are
    // pinned to the +Z playhead direction at the path's current sample;
    // the trajectory line itself rotates with sphereGroup, so the voice
    // marker visually rides the now-time as the path slides past.
    diffusion.voices.forEach((v, i) => {
      const m = s.voiceMarkers[i]
      m.visible = !!v.poolId
      if (m.parent !== s.scene) { m.parent?.remove(m); s.scene.add(m) }
    })

    // sync trajectory lines + ribbons — parented to scene (world space) so
    // paths stay put while the sphere's orientation rings rotate as the time
    // clock. The ribbon is a translucent fan from origin (listener) out to
    // each path vertex, so depth = ribbon length is visually obvious.
    const trajs = diffusion.trajectories || []
    while (s.trajectoryLines.length > trajs.length) {
      const l = s.trajectoryLines.pop()
      s.scene.remove(l)
      l.geometry.dispose(); l.material.dispose()
      const r = s.trajectoryRibbons.pop()
      if (r) { s.scene.remove(r); r.geometry.dispose(); r.material.dispose() }
    }
    while (s.trajectoryLines.length < trajs.length) {
      const lineGeom = new THREE.BufferGeometry()
      const linePositions = new Float32Array(MAX_LINE_PTS * 3)
      lineGeom.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
      lineGeom.setDrawRange(0, 0)
      const lineMat = new THREE.LineBasicMaterial({ color: hl, depthTest: false, transparent: true, opacity: 0.95 })
      const line = new THREE.Line(lineGeom, lineMat)
      line.renderOrder = 5
      s.scene.add(line)
      s.trajectoryLines.push(line)
      const ribbon = makeRibbon(0xffffff, 1)
      s.scene.add(ribbon)
      s.trajectoryRibbons.push(ribbon)
    }
    trajs.forEach((traj, ti) => {
      const line = s.trajectoryLines[ti]
      line.material.color.setHex(hl)
      const pts = traj.points
      const positions = line.geometry.attributes.position.array
      const n = Math.min(pts.length, MAX_LINE_PTS)
      for (let p = 0; p < n; p++) {
        positions[p * 3]     = pts[p].x
        positions[p * 3 + 1] = pts[p].y
        positions[p * 3 + 2] = pts[p].z
      }
      line.geometry.attributes.position.needsUpdate = true
      line.geometry.setDrawRange(0, n)
      line.geometry.computeBoundingSphere()

      const ribbon = s.trajectoryRibbons[ti]
      ribbon.material.color.setHex(hl)
      fillRibbon(ribbon, pts)
    })
  }, [diffusion, highlight])

  // ---- rAF loop: rotation phase, audio panners, render ----
  const drawModeRef = useRef(drawMode); drawModeRef.current = drawMode
  const phaseRef = useRef(0)

  useEffect(() => {
    let raf, last = performance.now()
    const tick = () => {
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const d = diffRef.current
      const s = sceneRef.current
      if (!d || !s) { raf = requestAnimationFrame(tick); return }

      const period = Math.max(0.5, d.rotationPeriodSec || 8)
      if (!drawModeRef.current) {
        phaseRef.current = (phaseRef.current + dt * (Math.PI * 2 / period)) % (Math.PI * 2)
      }
      const phi = phaseRef.current
      s.sphereGroup.rotation.y = phi
      // Keep camera zoom (wheel) always available; rotate is disabled while
      // drawing or dragging a voice so dragging doesn't orbit the camera.
      s.controls.enableRotate = !drawModeRef.current && draggingRef.current === null
      s.controls.update()
      // Depth-target shell: visible while drawing, scaled to current depth.
      const dd = drawDepthRef.current
      s.depthGroup.visible = drawModeRef.current
      s.depthGroup.scale.set(dd, dd, dd)

      const a = audioRef.current
      d.voices.forEach((v, i) => {
        const marker = s.voiceMarkers[i]
        if (!marker || !marker.visible) return
        let world
        const traj = (v.trajectoryId >= 0 && v.trajectoryId < (d.trajectories?.length || 0))
          ? d.trajectories[v.trajectoryId] : null
        if (traj && traj.points.length >= 2) {
          const t = (((phi / (Math.PI * 2)) + (v.phaseOffset || 0)) % 1 + 1) % 1
          world = samplePath3(traj.points, t)
        } else if (v.position) {
          world = v.position
        }
        if (world) marker.position.set(world.x, world.y, world.z)
        if (a && world) {
          a.voices[i].panner.setPosition(world.x * d.radius, world.y * d.radius, -world.z * d.radius)
          // Magnitude-based proximity: near origin = louder, surface = quieter.
          // 0.4 / (0.2 + mag) → mag 0.1 ≈ +2.5 dB, mag 0.5 ≈ -5 dB, mag 1.0 ≈ -10 dB.
          const mag = Math.hypot(world.x, world.y, world.z)
          a.voices[i].distGain.gain.value = Math.max(0.05, Math.min(2, 0.4 / (0.2 + mag)))
        }
      })

      // refresh in-progress drawing line + ribbon (mutate pre-allocated arrays)
      if (drawingPtsRef.current && s.drawingLine) {
        const pts = drawingPtsRef.current
        const positions = s.drawingLine.geometry.attributes.position.array
        const n = Math.min(pts.length, MAX_LINE_PTS)
        for (let p = 0; p < n; p++) {
          positions[p * 3]     = pts[p].x
          positions[p * 3 + 1] = pts[p].y
          positions[p * 3 + 2] = pts[p].z
        }
        s.drawingLine.geometry.attributes.position.needsUpdate = true
        s.drawingLine.geometry.setDrawRange(0, n)
        s.drawingLine.geometry.computeBoundingSphere()
        if (s.drawingRibbon) fillRibbon(s.drawingRibbon, pts)
      }

      s.renderer.render(s.scene, s.camera)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- keyboard: Up/Down arrows scrub depth (always — not gated by draw
  // mode). Capture-phase listener so it fires before any focused element
  // swallows the keys. Logs to console so you can verify it fires.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const t = e.target
      // Let range sliders / text inputs handle their own native step.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      e.preventDefault()
      e.stopPropagation()
      const delta = e.key === 'ArrowUp' ? 0.1 : -0.1
      setDrawDepth(d => Math.max(0.1, Math.min(1, +(d + delta).toFixed(2))))
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // ---- pointer / raycast helpers ----
  const setNDC = (e) => {
    const s = sceneRef.current
    if (!s) return false
    const r = s.renderer.domElement.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    s.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1
    s.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1
    return true
  }

  const raycastSphereWorld = () => {
    const s = sceneRef.current
    if (!s) return null
    s.raycaster.setFromCamera(s.ndc, s.camera)
    const hits = s.raycaster.intersectObject(s.sphereMesh, false)
    if (!hits.length) return null
    const p = hits[0].point
    const len = Math.hypot(p.x, p.y, p.z) || 1
    return { x: p.x / len, y: p.y / len, z: p.z / len }
  }

  const raycastVoiceMarker = () => {
    const s = sceneRef.current
    if (!s) return -1
    s.raycaster.setFromCamera(s.ndc, s.camera)
    const visible = s.voiceMarkers.filter(m => m.visible)
    if (!visible.length) return -1
    const hits = s.raycaster.intersectObjects(visible, false)
    if (!hits.length) return -1
    return s.voiceMarkers.indexOf(hits[0].object)
  }

  const onPointerDown = (e) => {
    if (!setNDC(e)) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const s = sceneRef.current
    if (!s) return
    if (drawMode) {
      const dir = raycastSphereWorld()
      if (!dir) return
      const d = drawDepthRef.current
      drawingPtsRef.current = [{ x: dir.x * d, y: dir.y * d, z: dir.z * d }]
      if (!s.drawingLine) {
        const g = new THREE.BufferGeometry()
        const positions = new Float32Array(MAX_LINE_PTS * 3)
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        g.setDrawRange(0, 0)
        const m = new THREE.LineBasicMaterial({ color: hexToInt(highlight), depthTest: false, transparent: true, opacity: 0.95 })
        s.drawingLine = new THREE.Line(g, m)
        s.drawingLine.renderOrder = 6
        s.scene.add(s.drawingLine)
      }
      if (!s.drawingRibbon) {
        s.drawingRibbon = makeRibbon(0xffff00, 1)
        s.scene.add(s.drawingRibbon)
      }
      return
    }
    const idx = raycastVoiceMarker()
    if (idx >= 0) {
      const v = diffRef.current.voices[idx]
      if (!v.trajectoryId || v.trajectoryId < 0) {
        draggingRef.current = idx
      }
    }
  }

  const onPointerMove = (e) => {
    if (!setNDC(e)) return
    if (drawMode && drawingPtsRef.current) {
      const dir = raycastSphereWorld()
      if (!dir) return
      const d = drawDepthRef.current
      const next = { x: dir.x * d, y: dir.y * d, z: dir.z * d }
      const last = drawingPtsRef.current[drawingPtsRef.current.length - 1]
      const dx = next.x - last.x, dy = next.y - last.y, dz = next.z - last.z
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > DRAW_MIN_STEP) {
        drawingPtsRef.current.push(next)
      }
      return
    }
    if (draggingRef.current !== null) {
      const i = draggingRef.current
      const dir = raycastSphereWorld()
      if (!dir) return
      const d = drawDepthRef.current
      const pos = { x: dir.x * d, y: dir.y * d, z: dir.z * d }
      setDiffusion(prev => {
        const nv = prev.voices.slice()
        nv[i] = { ...nv[i], position: pos }
        return { ...prev, voices: nv }
      })
    }
  }

  const onPointerUp = () => {
    if (drawMode && drawingPtsRef.current) {
      const pts = drawingPtsRef.current
      const s = sceneRef.current
      if (pts.length >= 2) {
        setDiffusion(prev => ({
          ...prev,
          trajectories: [...(prev.trajectories || []), { points: pts, name: `path ${(prev.trajectories?.length || 0) + 1}` }],
        }))
      }
      drawingPtsRef.current = null
      if (s?.drawingLine) {
        s.scene.remove(s.drawingLine)
        s.drawingLine.geometry.dispose()
        s.drawingLine.material.dispose()
        s.drawingLine = null
      }
      if (s?.drawingRibbon) {
        s.scene.remove(s.drawingRibbon)
        s.drawingRibbon.geometry.dispose()
        s.drawingRibbon.material.dispose()
        s.drawingRibbon = null
      }
      setDrawMode(false)
    }
    draggingRef.current = null
  }

  const deleteTrajectory = (ti) => {
    setDiffusion(prev => {
      const newTrajs = prev.trajectories.filter((_, i) => i !== ti)
      const newVoices = prev.voices.map(v => ({
        ...v,
        trajectoryId: v.trajectoryId === ti ? -1 : v.trajectoryId > ti ? v.trajectoryId - 1 : v.trajectoryId,
      }))
      return { ...prev, trajectories: newTrajs, voices: newVoices }
    })
  }

  const setVoiceProp = (i, prop, val) => {
    setDiffusion(prev => { const nv = prev.voices.slice(); nv[i] = { ...nv[i], [prop]: val }; return { ...prev, voices: nv } })
  }

  const radius = diffusion.radius || 4
  const rotationPeriodSec = diffusion.rotationPeriodSec || 8
  const trajectories = diffusion.trajectories || []

  return (
    <div className="diffusion-tab">
      <div className="toolbar">
        <button className={diffusion.enabled ? 'active' : ''} onClick={() => setDiffusion(prev => ({ ...prev, enabled: !prev.enabled }))}>
          {diffusion.enabled ? '◉ Binaural ON' : '○ Binaural OFF'}
        </button>
        <button onClick={playing.some(Boolean) ? stopAll : playAll}>{playing.some(Boolean) ? '■ Stop all' : '▶ Play all'}</button>
        <input type="text" value={captureName} onChange={e => setCaptureName(e.target.value)} placeholder="capture name" style={{ width: 120 }} />
        {!recording ? <button onClick={startRecord}>● Rec → pool</button> : <button className="recording" onClick={stopRecord}>Stop rec</button>}
        <button className={drawMode ? 'active' : ''} onClick={() => {
          drawingPtsRef.current = null
          const s = sceneRef.current
          if (s?.drawingLine) {
            s.scene.remove(s.drawingLine)
            s.drawingLine.geometry.dispose(); s.drawingLine.material.dispose()
            s.drawingLine = null
          }
          if (s?.drawingRibbon) {
            s.scene.remove(s.drawingRibbon)
            s.drawingRibbon.geometry.dispose(); s.drawingRibbon.material.dispose()
            s.drawingRibbon = null
          }
          setDrawMode(!drawMode)
        }}>
          {drawMode ? '✎ Drawing...' : '✎ Draw path'}
        </button>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Depth</label>
        <input type="range" min="0.1" max="1" step="0.01" value={drawDepth} onChange={e => setDrawDepth(+e.target.value)} style={{ width: 70 }} />
        <span style={{ color: 'var(--hl)', fontSize: 10 }}>{(drawDepth * 100).toFixed(0)}%</span>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Period</label>
        <input type="range" min="0.5" max="60" step="0.1" value={rotationPeriodSec} onChange={e => setDiffusion(prev => ({ ...prev, rotationPeriodSec: +e.target.value }))} style={{ width: 80 }} />
        <span style={{ color: 'var(--hl)', fontSize: 10 }}>{rotationPeriodSec.toFixed(1)}s</span>
        <label style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: 1, marginLeft: 8 }}>Radius</label>
        <input type="range" min="1" max="50" step="0.5" value={radius} onChange={e => setDiffusion(prev => ({ ...prev, radius: +e.target.value }))} style={{ width: 80 }} />
        <span style={{ color: 'var(--hl)', fontSize: 10 }}>{radius}m</span>
        <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 'auto' }}>headphones required</span>
      </div>
      <div className="diffusion-layout">
        <div ref={containerRef}
          className={'diffusion-sphere' + (drawMode ? ' drawing' : '')}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        />
        <div className="diffusion-voices">
          {Array.from({ length: MAX_VOICES }).map((_, i) => {
            const v = diffusion.voices[i] || {}
            const pos = v.position || { x: 0, y: 0, z: 1 }
            const lat = Math.asin(Math.max(-1, Math.min(1, pos.y))) * 180 / Math.PI
            const lon = Math.atan2(pos.x, pos.z) * 180 / Math.PI
            return (
              <div key={i} className="panel diffusion-voice-panel">
                <h4>Voice {i + 1}
                  <button className={'tiny-toggle' + (playing[i] ? ' active' : '')} onClick={() => playing[i] ? stopVoice(i) : playVoice(i)}>{playing[i] ? '■' : '▶'}</button>
                </h4>
                <div className="row">
                  <label>Source</label>
                  <select className="select-inline" value={v.poolId || ''}
                    onChange={e => { const pid = e.target.value; setVoiceProp(i, 'poolId', pid); stopVoice(i); if (pid) playVoice(i, pid) }}>
                    <option value="">— none —</option>
                    {pool.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="row"><label>Lat / Lon</label><span className="value">{lat.toFixed(0)}° · {lon.toFixed(0)}°</span></div>
                <div className="row">
                  <label>Path</label>
                  <select className="select-inline" value={v.trajectoryId ?? -1}
                    onChange={e => setVoiceProp(i, 'trajectoryId', +e.target.value)}>
                    <option value={-1}>— none —</option>
                    {trajectories.map((t, ti) => <option key={ti} value={ti}>{t.name || `path ${ti + 1}`}</option>)}
                  </select>
                </div>
                <div className="row">
                  <label>Phase</label>
                  <input className="slider" type="range" min="0" max="1" step="0.01" value={v.phaseOffset || 0} onChange={e => setVoiceProp(i, 'phaseOffset', +e.target.value)} />
                  <span className="value">{((v.phaseOffset || 0) * 100).toFixed(0)}%</span>
                </div>
              </div>
            )
          })}
          {trajectories.length > 0 && (
            <div className="panel diffusion-voice-panel">
              <h4>Paths</h4>
              {trajectories.map((t, ti) => (
                <div key={ti} className="row">
                  <label>{t.name || `path ${ti + 1}`}</label>
                  <span className="value">{t.points.length} pts</span>
                  <button className="pool-btn pool-btn-del" onClick={() => deleteTrajectory(ti)} title="delete">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
