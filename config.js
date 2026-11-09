import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL(".", import.meta.url));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The manifest is the single source of defaults and constraints. No value coercion.
export function validateConfig(points, values) {
  const errors = [];
  if (!isObject(values)) return ["a raiz deve ser um mapa de configurações"];
  for (const key of Object.keys(values)) {
    if (!points.some((point) => point.key === key)) errors.push(`${key}: configuração desconhecida`);
  }
  function check(spec, value, path) {
    switch (spec.type) {
      case "string": case "text":
        if (typeof value !== "string") return errors.push(`${path}: informe um texto`);
        if ([...value].length > (spec.max_length ?? Infinity)) errors.push(`${path}: máximo de ${spec.max_length} caracteres`);
        if (spec.pattern && !new RegExp(spec.pattern, "u").test(value)) errors.push(`${path}: formato inválido`);
        break;
      case "email":
        if (typeof value !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errors.push(`${path}: informe um e-mail válido`);
        break;
      case "group":
        if (typeof value !== "string" || !value.trim()) errors.push(`${path}: informe um nome de grupo não vazio`);
        break;
      case "list":
        if (!Array.isArray(value)) return errors.push(`${path}: informe uma lista`);
        if (value.length < (spec.min_items ?? 0)) errors.push(`${path}: mínimo de ${spec.min_items} itens`);
        if (value.length > (spec.max_items ?? Infinity)) errors.push(`${path}: máximo de ${spec.max_items} itens`);
        value.forEach((item, index) => check(spec.items, item, `${path}[${index}]`));
        break;
      case "integer": case "number":
        if (typeof value !== "number" || !Number.isFinite(value) || (spec.type === "integer" && !Number.isInteger(value))) {
          return errors.push(`${path}: informe um ${spec.type === "integer" ? "inteiro" : "número"} finito`);
        }
        if (value < (spec.minimum ?? -Infinity) || value > (spec.maximum ?? Infinity)) errors.push(`${path}: valor fora dos limites declarados`);
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`${path}: informe true ou false`);
        break;
      default:
        errors.push(`${path}: tipo de configuração não suportado pelo app (${spec.type})`);
    }
  }
  for (const point of points) {
    if (Object.hasOwn(values, point.key)) check(point, values[point.key], point.key);
    else if (Object.hasOwn(point, "default")) check(point, point.default, point.key);
    else if (point.required) errors.push(`${point.key}: configuração obrigatória ausente`);
  }
  return errors;
}

export function effectiveConfig(points, values) {
  const errors = validateConfig(points, values);
  if (errors.length) throw new Error(`Configuração inválida em ihapp-config.yaml:\n- ${errors.join("\n- ")}\nCorrija os campos conforme ihapp-catalog.yaml e reinicie o app.`);
  return Object.fromEntries(points.filter((point) => Object.hasOwn(values, point.key) || Object.hasOwn(point, "default"))
    .map((point) => [point.key, structuredClone(Object.hasOwn(values, point.key) ? values[point.key] : point.default)]));
}

export async function loadConfig(directory = root) {
  const manifest = parse(await readFile(resolve(directory, "ihapp-catalog.yaml"), "utf8"));
  let values = {};
  try {
    values = parse(await readFile(resolve(directory, "ihapp-config.yaml"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Não foi possível ler ihapp-config.yaml. Corrija a sintaxe YAML e reinicie o app.");
  }
  return effectiveConfig(manifest.config, values);
}
