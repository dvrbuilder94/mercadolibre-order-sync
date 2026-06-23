import { describe, it, expect } from "vitest";
import { linkIsVigente, orderHasDoc } from "./taxDocs";

describe("linkIsVigente", () => {
  it("acepta un documento emitido (status distinto de voided)", () => {
    expect(linkIsVigente({ tax_documents: { status: "issued" } })).toBe(true);
  });

  it("rechaza un documento anulado", () => {
    expect(linkIsVigente({ tax_documents: { status: "voided" } })).toBe(false);
  });

  it("rechaza vínculos vacíos o sin documento", () => {
    expect(linkIsVigente(null)).toBe(false);
    expect(linkIsVigente(undefined)).toBe(false);
    expect(linkIsVigente({})).toBe(false);
    expect(linkIsVigente({ tax_documents: null })).toBe(false);
  });

  it("acepta tax_documents entregado como arreglo (forma to-one de PostgREST)", () => {
    expect(linkIsVigente({ tax_documents: [{ status: "issued" }] })).toBe(true);
    expect(linkIsVigente({ tax_documents: [{ status: "voided" }] })).toBe(false);
  });
});

describe("orderHasDoc", () => {
  it("false si la orden no tiene vínculos", () => {
    expect(orderHasDoc(null)).toBe(false);
    expect(orderHasDoc(undefined)).toBe(false);
    expect(orderHasDoc([])).toBe(false);
  });

  it("true si tiene al menos un documento vigente", () => {
    expect(orderHasDoc([{ tax_documents: { status: "issued" } }])).toBe(true);
  });

  it("false si todos los vínculos están anulados", () => {
    expect(orderHasDoc([
      { tax_documents: { status: "voided" } },
      { tax_documents: { status: "voided" } },
    ])).toBe(false);
  });

  it("true si convive un anulado con uno vigente (este era el bug que cruzaba módulos)", () => {
    expect(orderHasDoc([
      { tax_documents: { status: "voided" } },
      { tax_documents: { status: "issued" } },
    ])).toBe(true);
  });
});
