import { describe, expect, it } from "vitest";
import {
  buildTaxDocumentPayload,
  extractDocPayments,
  extractExternalOrderId,
  isValidTributaryDoc,
  mapBsaleDocType,
  mergePaymentEnrichment,
  splitRut,
  unresolvedPaymentTypeIds,
} from "./bsale-document.ts";

const baseDoc = (overrides: Record<string, unknown> = {}) => ({
  id: 991,
  number: 4567,
  emissionDate: 1_754_006_400,
  state: 0,
  netAmount: 10000,
  taxAmount: 1900,
  totalAmount: 11900,
  document_type: { codeSii: 39, name: "BOLETA ELECTRONICA" },
  client: { code: "76543210-K", company: "Cliente SPA", note: "Orden 2000011263225013" },
  coin: { name: "Peso Chileno" },
  references: { items: [{ reason: "Venta Mercado Libre", number: "2000011263225013" }] },
  ...overrides,
});

describe("mapBsaleDocType", () => {
  it("mapea estrictamente los códigos SII válidos", () => {
    expect(mapBsaleDocType(33)).toBe("factura");
    expect(mapBsaleDocType(34)).toBe("factura_exenta");
    expect(mapBsaleDocType(39)).toBe("boleta");
    expect(mapBsaleDocType(41)).toBe("boleta");
    expect(mapBsaleDocType(56)).toBe("nota_debito");
    expect(mapBsaleDocType("61")).toBe("nota_credito");
  });

  it("no hace fallback a boleta con códigos inválidos", () => {
    expect(mapBsaleDocType(52)).toBeNull();
    expect(mapBsaleDocType(null)).toBeNull();
    expect(mapBsaleDocType(undefined)).toBeNull();
    expect(mapBsaleDocType("abc")).toBeNull();
  });

  it("rechaza guías de despacho y notas de venta", () => {
    expect(isValidTributaryDoc({ document_type: { codeSii: 52, name: "GUÍA DE DESPACHO" } })).toBe(false);
    expect(isValidTributaryDoc({ document_type: { name: "NOTA VENTA" } })).toBe(false);
    expect(isValidTributaryDoc({ document_type: { codeSii: 33, name: "FACTURA" } })).toBe(true);
  });
});

describe("splitRut", () => {
  it("separa cuerpo y dígito verificador", () => {
    expect(splitRut("76.543.210-K")).toEqual({ body: "76543210", dv: "K" });
    expect(splitRut(null)).toEqual({ body: null, dv: null });
  });
});

describe("extractExternalOrderId", () => {
  it("extrae el id de orden desde client.note", () => {
    expect(extractExternalOrderId(baseDoc())).toBe("2000011263225013");
  });

  it("extrae el id de orden desde references cuando no hay nota", () => {
    const doc = baseDoc({ client: { code: "1-9" } });
    expect(extractExternalOrderId(doc)).toBe("2000011263225013");
  });

  it("devuelve null si no hay identificador largo", () => {
    expect(extractExternalOrderId({ client: { note: "venta 123" } })).toBeNull();
  });
});

describe("formas de pago", () => {
  it("usa payment_type.name cuando Bsale lo entrega", () => {
    const doc = baseDoc({
      payments: { items: [{ id: 1, amount: 11900, payment_type: { id: 5, name: "Tarjeta de Crédito" } }] },
    });
    const result = extractDocPayments(doc);
    expect(result.payment_method_names).toEqual(["Tarjeta de Crédito"]);
    expect(result.payment_method_name).toBe("Tarjeta de Crédito");
  });

  it("resuelve el nombre por id/href usando el catálogo", () => {
    const doc = baseDoc({
      payments: {
        items: [
          { id: 1, amount: 5000, payment_type: { href: "https://api.bsale.cl/v1/payment_types/7.json" } },
          { id: 2, amount: 6900, payment_type: { id: 9 } },
        ],
      },
    });
    expect(unresolvedPaymentTypeIds(doc)).toEqual(["7", "9"]);
    const catalog = new Map([["7", "Efectivo"], ["9", "Tarjeta"]]);
    const result = extractDocPayments(doc, catalog);
    expect(result.payment_method_names).toEqual(["Efectivo", "Tarjeta"]);
    expect(result.payment_method_name).toBeNull();
  });

  it("nunca usa coin.name ('Peso Chileno') como forma de pago", () => {
    const payload = buildTaxDocumentPayload(baseDoc(), { userId: "u1" });
    expect(payload.raw_data.payment_method_names).toEqual([]);
    expect(payload.raw_data.payment_method_name).toBeNull();
    expect(JSON.stringify(payload.raw_data.payment_method_names)).not.toContain("Peso Chileno");
    expect(payload.raw_data.coin).toEqual({ name: "Peso Chileno" });
  });
});

describe("buildTaxDocumentPayload", () => {
  it("produce el payload canónico de tax_documents", () => {
    const payload = buildTaxDocumentPayload(baseDoc(), { userId: "u1", batchId: "b1" });
    expect(payload).toMatchObject({
      user_id: "u1",
      document_type: "boleta",
      document_number: "4567",
      external_system: "bsale",
      external_id: "991",
      erp: "BSALE",
      sales_channel: "MARKETPLACE",
      detected_channel: "meli",
      status: "issued",
      resync_batch: "b1",
    });
    expect(payload.raw_data.reference_reason).toBe("Venta Mercado Libre");
    expect(payload.raw_data.external_order_id).toBe("2000011263225013");
  });

  it("devuelve null para documentos no tributarios", () => {
    expect(buildTaxDocumentPayload({ id: 1, document_type: { codeSii: 52 } }, { userId: "u1" })).toBeNull();
  });
});

describe("mergePaymentEnrichment", () => {
  it("preserva la forma de pago existente si el webhook llega sin pagos", () => {
    const incoming = { payments: [], payment_method_names: [], payment_method_name: null, number: 4567 };
    const existing = {
      payments: [{ id: 1, payment_type_name: "Efectivo" }],
      payment_method_names: ["Efectivo"],
      payment_method_name: "Efectivo",
    };
    const merged = mergePaymentEnrichment(incoming, existing);
    expect(merged.payment_method_names).toEqual(["Efectivo"]);
    expect(merged.payment_method_name).toBe("Efectivo");
    expect(merged.payments).toEqual(existing.payments);
    expect(merged.number).toBe(4567);
  });

  it("usa los pagos entrantes cuando sí vienen", () => {
    const incoming = {
      payments: [{ id: 2, payment_type_name: "Tarjeta" }],
      payment_method_names: ["Tarjeta"],
      payment_method_name: "Tarjeta",
    };
    const existing = { payment_method_names: ["Efectivo"], payment_method_name: "Efectivo" };
    expect(mergePaymentEnrichment(incoming, existing)).toBe(incoming);
  });

  it("no inventa nada si tampoco hay enriquecimiento previo", () => {
    const incoming = { payments: [], payment_method_names: [], payment_method_name: null };
    expect(mergePaymentEnrichment(incoming, null)).toBe(incoming);
  });
});
describe("external_url fallback", () => {
  it("prefiere urlPublicView", () => {
    const payload = buildTaxDocumentPayload(
      baseDoc({ urlPublicView: "a", urlPublicViewOriginal: "b", urlPdf: "c" }),
      { userId: "u1" },
    );
    expect(payload!.external_url).toBe("a");
  });

  it("cae a urlPublicViewOriginal y luego a urlPdf", () => {
    expect(
      buildTaxDocumentPayload(baseDoc({ urlPublicViewOriginal: "b", urlPdf: "c" }), { userId: "u1" })!.external_url,
    ).toBe("b");
    expect(
      buildTaxDocumentPayload(baseDoc({ urlPdf: "c" }), { userId: "u1" })!.external_url,
    ).toBe("c");
  });

  it("queda null si no hay ninguna URL", () => {
    expect(buildTaxDocumentPayload(baseDoc(), { userId: "u1" })!.external_url).toBeNull();
  });
});

describe("payments en array directo (formato Bsale alternativo)", () => {
  it("resuelve nombre vía paymentTypeId + catálogo", () => {
    const doc = baseDoc({
      payments: [{ id: 7, amount: 11900, recordDate: 1_754_006_400, paymentTypeId: 4 }],
    });
    const res = extractDocPayments(doc, new Map([["4", "Transferencia"]]));
    expect(res.payments).toHaveLength(1);
    expect(res.payments[0].payment_type_id).toBe("4");
    expect(res.payments[0].amount).toBe(11900);
    expect(res.payments[0].recordDate).toBe(1_754_006_400);
    expect(res.payment_method_name).toBe("Transferencia");
  });

  it("sigue funcionando con payments.items y payment_type anidado", () => {
    const doc = baseDoc({
      payments: { items: [{ id: 1, amount: 100, recordDate: 1, payment_type: { id: 9, name: "Efectivo" } }] },
    });
    const res = extractDocPayments(doc);
    expect(res.payment_method_names).toEqual(["Efectivo"]);
  });

  it("unresolvedPaymentTypeIds funciona en ambos formatos", () => {
    expect(unresolvedPaymentTypeIds(baseDoc({ payments: [{ paymentTypeId: 4 }, { payment_type_id: 5 }] })))
      .toEqual(["4", "5"]);
    expect(unresolvedPaymentTypeIds(baseDoc({
      payments: { items: [{ payment_type: { href: "https://api.bsale.cl/v1/payment_types/8.json" } }] },
    }))).toEqual(["8"]);
    expect(unresolvedPaymentTypeIds(baseDoc({
      payments: [{ payment_type: { id: 3, name: "Débito" } }],
    }))).toEqual([]);
  });

  it("coin Peso Chileno nunca es forma de pago", () => {
    const payload = buildTaxDocumentPayload(
      baseDoc({ coin: { name: "Peso Chileno" }, payments: [{ paymentTypeId: 4, amount: 10 }] }),
      { userId: "u1", paymentTypeNames: new Map([["4", "Transferencia"]]) },
    );
    expect(payload!.raw_data.payment_method_names).toEqual(["Transferencia"]);
    expect(JSON.stringify(payload!.raw_data.payment_method_names)).not.toContain("Peso Chileno");
  });

  it("shape LIVE: item es payment type expandido (href /payment_types/11.json)", () => {
    const doc = baseDoc({
      payments: [{ href: "https://api.bsale.cl/v1/payment_types/11.json", id: 11, name: "Mercado Pago", amount: 64980 }],
    });
    const res = extractDocPayments(doc);
    expect(res.payments[0].payment_type_id).toBe("11");
    expect(res.payments[0].payment_type_name).toBe("Mercado Pago");
    expect(res.payments[0].amount).toBe(64980);
    expect(res.payment_method_names).toEqual(["Mercado Pago"]);
    expect(unresolvedPaymentTypeIds(doc)).toEqual([]);
  });

  it("item genérico sin href payment_types no usa su id como payment_type_id", () => {
    const res = extractDocPayments(baseDoc({ payments: [{ id: 999, amount: 100 }] }));
    expect(res.payments[0].payment_type_id).toBeNull();
    expect(res.payments[0].payment_type_name).toBeNull();
    expect(res.payments[0].id).toBe(999);
    expect(res.payment_method_names).toEqual([]);
  });
});
