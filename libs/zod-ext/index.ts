import z from "zod";

export const looseString = z
  .preprocess((value) => {
    if (value == null) {
      return undefined;
    }
    return String(value).trim();
  }, z.string().optional())
  .optional();

export const looseBool = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value == null || value === "") {
      return defaultValue;
    }
    if (typeof value === "boolean") {
      return value;
    }
    const text = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(text)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(text)) {
      return false;
    }
    return defaultValue;
  }, z.boolean());

export const looseNumber = (defaultValue: number) =>
  z.preprocess((value) => {
    if (value == null || value === "") {
      return defaultValue;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }, z.number());

