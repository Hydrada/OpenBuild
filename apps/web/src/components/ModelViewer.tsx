import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { IfcAPI } from "web-ifc";
import wasmUrl from "web-ifc/web-ifc.wasm?url";

/**
 * In-browser IFC viewer: web-ifc tessellates the model, three.js renders it with orbit/pan/zoom.
 * Elements whose GlobalId is in `highlight` (e.g. clashing elements) are drawn red; the rest keep model colours.
 */
export default function ModelViewer({ fileUrl, highlight = [] }: { fileUrl: string; highlight?: string[] }) {
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading model…");
  const [count, setCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    const el = mount.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f4f7);
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(30, 60, 40);
    scene.add(sun);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    let frame = 0;
    const render = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render); };
    const onResize = () => { camera.aspect = el.clientWidth / el.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(el.clientWidth, el.clientHeight); };
    addEventListener("resize", onResize);

    (async () => {
      try {
        const ifc = new IfcAPI();
        await ifc.Init(() => wasmUrl, true);
        const res = await fetch(fileUrl, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`Download failed (${res.status})`);
        const model = ifc.OpenModel(new Uint8Array(await res.arrayBuffer()));
        const hl = new Set(highlight);
        const group = new THREE.Group();
        let elements = 0;
        ifc.StreamAllMeshes(model, (mesh) => {
          elements++;
          const gid = (ifc.GetLine(model, mesh.expressID) as { GlobalId?: { value: string } })?.GlobalId?.value;
          for (let i = 0; i < mesh.geometries.size(); i++) {
            const pg = mesh.geometries.get(i);
            const geo = ifc.GetGeometry(model, pg.geometryExpressID);
            const v = ifc.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
            const idx = ifc.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
            const pos = new Float32Array(v.length / 2), nor = new Float32Array(v.length / 2);
            for (let k = 0; k < v.length; k += 6) { pos.set([v[k]!, v[k + 1]!, v[k + 2]!], k / 2); nor.set([v[k + 3]!, v[k + 4]!, v[k + 5]!], k / 2); }
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
            g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
            g.setIndex(new THREE.BufferAttribute(idx, 1));
            const c = pg.color;
            const hit = gid !== undefined && hl.has(gid);
            const mat = new THREE.MeshLambertMaterial({ color: hit ? 0xdc2626 : new THREE.Color(c.x, c.y, c.z), transparent: !hit && c.w < 1, opacity: hit ? 1 : c.w, side: THREE.DoubleSide });
            const m = new THREE.Mesh(g, mat);
            m.applyMatrix4(new THREE.Matrix4().fromArray(pg.flatTransformation));
            group.add(m);
            geo.delete();
          }
        });
        ifc.CloseModel(model);
        if (disposed) return;
        scene.add(group);
        const box = new THREE.Box3().setFromObject(group);
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length() || 10;
        camera.position.copy(centre).add(new THREE.Vector3(size * 0.8, size * 0.6, size * 0.8));
        camera.near = size / 1000; camera.far = size * 100; camera.updateProjectionMatrix();
        controls.target.copy(centre);
        setCount(elements);
        setStatus(elements ? "" : "This model contains no 3D geometry (it only lists elements).");
        render();
      } catch (e) {
        setStatus(`Could not display the model: ${(e as Error).message}`);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [fileUrl, highlight.join("|")]);

  return (
    <div className="model-viewer">
      <div ref={mount} className="model-canvas" role="img" aria-label={status || `3D model with ${count} elements. Drag to orbit, right-drag to pan, scroll to zoom.`} data-elements={count} />
      {status && <p className={status.startsWith("Could") ? "error" : "muted"} role="status">{status}</p>}
    </div>
  );
}
