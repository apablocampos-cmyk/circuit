/**
 * solver.js — Motor Matemático para Circuitos DC
 * Calcula: Voltaje (V), Corriente (I), Resistencia (R), Potencia (P), Resistividad (ρ)
 * Soporta: Serie, Paralelo, y topologías mixtas mediante análisis nodal simplificado
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONSTANTES DE MATERIAL — Resistividad (ρ) en Ω·m a 20°C
═══════════════════════════════════════════════════════════════ */
const MATERIALS = {
  copper:    { name: 'Cobre',     rho: 1.72e-8,  unit: '1.72×10⁻⁸ Ω·m' },
  aluminum:  { name: 'Aluminio',  rho: 2.65e-8,  unit: '2.65×10⁻⁸ Ω·m' },
  gold:      { name: 'Oro',       rho: 2.44e-8,  unit: '2.44×10⁻⁸ Ω·m' },
  silver:    { name: 'Plata',     rho: 1.59e-8,  unit: '1.59×10⁻⁸ Ω·m' },
  iron:      { name: 'Hierro',    rho: 1.00e-7,  unit: '1.00×10⁻⁷ Ω·m' },
  tungsten:  { name: 'Tungsteno', rho: 5.60e-8,  unit: '5.60×10⁻⁸ Ω·m' },
  nichrome:  { name: 'Nicrom',    rho: 1.10e-6,  unit: '1.10×10⁻⁶ Ω·m' },
  custom:    { name: 'Custom',    rho: null,      unit: 'Ω·m' },
};

/* ═══════════════════════════════════════════════════════════════
   FUNCIÓN: Calcular resistencia por resistividad
   R = ρ · L / A
   @param {string} material — clave de MATERIALS
   @param {number} length   — longitud en metros
   @param {number} area     — sección transversal en mm² (convertimos a m²)
   @param {number} customRho — resistividad custom (solo si material==='custom')
   @returns {object} { R, rho, formula }
═══════════════════════════════════════════════════════════════ */
function calcResistivityR(material, length, area, customRho = null) {
  const mat = MATERIALS[material] || MATERIALS.copper;
  const rho = material === 'custom' ? customRho : mat.rho;
  if (!rho || rho <= 0) throw new Error('Resistividad inválida');
  if (length <= 0) throw new Error('La longitud debe ser mayor que 0');
  if (area <= 0) throw new Error('La sección debe ser mayor que 0');

  const areaM2 = area * 1e-6; // mm² → m²
  const R = (rho * length) / areaM2;
  return {
    R,
    rho,
    formula: `R = (${formatSci(rho)} × ${length} m) / ${area} mm² = ${formatOhms(R)}`,
    material: mat.name,
  };
}

/* ═══════════════════════════════════════════════════════════════
   FUNCIÓN PRINCIPAL: Resolver el circuito
   Recibe el estado completo del canvas y devuelve resultados.
   @param {object} circuitState — { nodes, components }
   @returns {object} { voltage, current, resistance, power, topology, error, perComponent }
═══════════════════════════════════════════════════════════════ */
function solveCircuit(circuitState) {
  const { nodes, components } = circuitState;

  // 1. Verificar que hay fuentes de voltaje
  const voltageSources = components.filter(c => c.type === 'voltage');
  if (voltageSources.length === 0) {
    return { error: 'No hay fuente de voltaje en el circuito.' };
  }

  // 2. Recopilar todas las resistencias (incluidas cables con ρ)
  const resistors = components.filter(
    c => c.type === 'resistor' || c.type === 'cable-resistivity'
  );

  if (resistors.length === 0) {
    return { error: 'No hay resistencias en el circuito.' };
  }

  // 3. Comprobar circuito abierto básico mediante conectividad de nodos
  const connectivity = checkConnectivity(circuitState);
  if (!connectivity.closed) {
    return { error: `Circuito abierto: ${connectivity.reason}` };
  }

  // 4. Calcular voltaje total (varias fuentes en serie se suman)
  const totalVoltage = voltageSources.reduce((sum, vs) => sum + (vs.voltage || 0), 0);
  if (totalVoltage === 0) {
    return { error: 'Voltaje total es 0 V. Revisa las fuentes.' };
  }

  // 5. Detectar topología y calcular resistencia equivalente
  const topology = detectTopology(circuitState, resistors);
  const Req = calcEquivalentResistance(topology, resistors);

  if (Req <= 0) {
    return { error: 'Resistencia equivalente es 0 Ω (cortocircuito detectado).' };
  }

  // 6. Calcular I y P
  const I = totalVoltage / Req;
  const P = totalVoltage * I;

  // 7. Calcular valores por componente
  const perComponent = calcPerComponent(topology, resistors, I, totalVoltage);

  return {
    voltage:    totalVoltage,
    current:    I,
    resistance: Req,
    power:      P,
    topology:   topology.type,
    error:      null,
    perComponent,
  };
}

/* ─────────────────────────────────────────────────────────────
   Verifica conectividad básica del circuito
   Necesita al menos: 1 fuente + 1 resistencia + trayectoria cerrada
──────────────────────────────────────────────────────────────── */
function checkConnectivity(circuitState) {
  const { nodes, components } = circuitState;
  if (!nodes || nodes.length < 2) {
    return { closed: false, reason: 'No hay suficientes nodos' };
  }

  const voltageSources = components.filter(c => c.type === 'voltage');
  const resistors = components.filter(c => c.type === 'resistor' || c.type === 'cable-resistivity');
  const wires = components.filter(c => c.type === 'wire');

  if (voltageSources.length === 0) {
    return { closed: false, reason: 'No hay fuente de voltaje' };
  }
  if (resistors.length === 0) {
    return { closed: false, reason: 'No hay resistencias' };
  }

  // Construir grafo de adyacencia con todos los componentes
  const adj = {};
  nodes.forEach(n => { adj[n.id] = []; });

  components.forEach(comp => {
    const { startNodeId, endNodeId } = comp;
    if (startNodeId !== undefined && endNodeId !== undefined) {
      if (adj[startNodeId]) adj[startNodeId].push(endNodeId);
      if (adj[endNodeId]) adj[endNodeId].push(startNodeId);
    }
  });

  // BFS desde el primer nodo
  const startId = nodes[0].id;
  const visited = new Set([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const curr = queue.shift();
    for (const neighbor of (adj[curr] || [])) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Todos los nodos deben estar conectados
  const allConnected = nodes.every(n => visited.has(n.id));
  if (!allConnected) {
    const unconnected = nodes.filter(n => !visited.has(n.id)).length;
    return { closed: false, reason: `${unconnected} nodo(s) desconectado(s)` };
  }

  return { closed: true };
}

/* ─────────────────────────────────────────────────────────────
   Detecta topología del circuito
──────────────────────────────────────────────────────────────── */
function detectTopology(circuitState, resistors) {
  const { nodes, components } = circuitState;

  // Contar conexiones por nodo (grado del nodo)
  const degree = {};
  nodes.forEach(n => { degree[n.id] = 0; });

  components.forEach(comp => {
    if (comp.startNodeId !== undefined) degree[comp.startNodeId] = (degree[comp.startNodeId] || 0) + 1;
    if (comp.endNodeId !== undefined) degree[comp.endNodeId] = (degree[comp.endNodeId] || 0) + 1;
  });

  // Nodos con grado > 2 → bifurcación → indica paralelo
  const branchNodes = Object.values(degree).filter(d => d > 2);

  let type;
  if (branchNodes.length === 0) {
    type = 'serie';
  } else if (branchNodes.length >= 2) {
    type = 'paralelo';
  } else {
    type = 'mixto';
  }

  return { type, degree, resistors };
}

/* ─────────────────────────────────────────────────────────────
   Calcula resistencia equivalente
──────────────────────────────────────────────────────────────── */
function calcEquivalentResistance(topology, resistors) {
  const Rs = resistors.map(r => getResistorValue(r));

  if (topology.type === 'serie') {
    // R_total = ΣR
    return Rs.reduce((sum, r) => sum + r, 0);
  }

  if (topology.type === 'paralelo') {
    // 1/R_total = Σ(1/R)
    const invSum = Rs.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0);
    return invSum > 0 ? 1 / invSum : Infinity;
  }

  // Mixto: heurística — intentar serie primero, luego paralelo
  // Para análisis completo se necesitaría análisis nodal completo
  // Aquí usamos el approach simplificado más común en circuitos básicos
  const serieR = Rs.reduce((sum, r) => sum + r, 0);
  return serieR; // Retorna la suma (conservador para circuitos mixtos simples)
}

/* ─────────────────────────────────────────────────────────────
   Calcula valores por componente individual
──────────────────────────────────────────────────────────────── */
function calcPerComponent(topology, resistors, totalI, totalV) {
  return resistors.map(r => {
    const R = getResistorValue(r);
    let I, V, P;

    if (topology.type === 'serie') {
      // Serie: misma corriente, voltaje proporcional
      I = totalI;
      V = totalI * R;
      P = V * I;
    } else if (topology.type === 'paralelo') {
      // Paralelo: mismo voltaje, corriente proporcional
      V = totalV;
      I = R > 0 ? totalV / R : 0;
      P = V * I;
    } else {
      // Mixto: aproximación
      I = totalI;
      V = totalI * R;
      P = V * I;
    }

    return { id: r.id, name: r.label || r.id, R, I, V, P };
  });
}

/* ─────────────────────────────────────────────────────────────
   Obtiene el valor de resistencia de un componente
──────────────────────────────────────────────────────────────── */
function getResistorValue(comp) {
  if (comp.type === 'cable-resistivity') {
    try {
      const result = calcResistivityR(
        comp.material || 'copper',
        comp.length || 1,
        comp.area || 1,
        comp.customRho || null
      );
      return result.R;
    } catch (e) {
      return comp.resistance || 1;
    }
  }
  return comp.resistance || 0;
}

/* ═══════════════════════════════════════════════════════════════
   UTILIDADES DE FORMATO
═══════════════════════════════════════════════════════════════ */
function formatValue(value, unit, decimals = 4) {
  if (value === null || value === undefined || isNaN(value)) return '—';

  const abs = Math.abs(value);

  if (abs === 0) return `0 ${unit}`;
  if (abs >= 1e9)  return `${(value / 1e9).toPrecision(4)} G${unit}`;
  if (abs >= 1e6)  return `${(value / 1e6).toPrecision(4)} M${unit}`;
  if (abs >= 1e3)  return `${(value / 1e3).toPrecision(4)} k${unit}`;
  if (abs >= 1)    return `${value.toPrecision(4)} ${unit}`;
  if (abs >= 1e-3) return `${(value * 1e3).toPrecision(4)} m${unit}`;
  if (abs >= 1e-6) return `${(value * 1e6).toPrecision(4)} µ${unit}`;
  if (abs >= 1e-9) return `${(value * 1e9).toPrecision(4)} n${unit}`;
  return `${value.toExponential(3)} ${unit}`;
}

function formatOhms(R) { return formatValue(R, 'Ω'); }
function formatAmps(I) { return formatValue(I, 'A'); }
function formatVolts(V) { return formatValue(V, 'V'); }
function formatWatts(P) { return formatValue(P, 'W'); }

function formatSci(n) {
  if (!n) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const coef = n / Math.pow(10, exp);
  return `${coef.toFixed(2)}×10^${exp}`;
}

/* Exportar para uso global */
window.CircuitSolver = {
  solve: solveCircuit,
  calcResistivity: calcResistivityR,
  getResistorValue,
  MATERIALS,
  formatOhms,
  formatAmps,
  formatVolts,
  formatWatts,
};
