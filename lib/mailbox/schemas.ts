import { z } from "zod/v4";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
export const passwordSchema = z
  .string()
  .min(8, "密码至少 8 位")
  .max(128, "密码不能超过 128 位");
const codeSchema = z.string().regex(/^\d{6}$/, "请输入 6 位邮箱验证码");
export const purposeSchema = z.enum(["register", "login", "reset", "change"]);
export type CodePurpose = z.infer<typeof purposeSchema>;
export const sendCodeSchema = z.object({
  email: emailSchema,
  purpose: purposeSchema,
});
export const registerSchema = z.object({
  email: emailSchema,
  code: codeSchema,
  password: z.union([passwordSchema, z.literal("")]).optional(),
});
export const loginSchema = z.discriminatedUnion("method", [
  z.object({ email: emailSchema, method: z.literal("code"), code: codeSchema }),
  z.object({
    email: emailSchema,
    method: z.literal("password"),
    password: z.string().min(1).max(128),
  }),
]);
export const resetSchema = z.object({
  email: emailSchema,
  code: codeSchema,
  newPassword: passwordSchema,
});
export const changeSchema = z.discriminatedUnion("method", [
  z.object({
    email: emailSchema,
    method: z.literal("code"),
    code: codeSchema,
    newPassword: passwordSchema,
  }),
  z.object({
    email: emailSchema,
    method: z.literal("password"),
    oldPassword: z.string().min(1).max(128),
    newPassword: passwordSchema,
  }),
]);
export const complaintSchema = z.object({
  recipients: z
    .array(emailSchema)
    .min(1, "请至少填写一个被投诉人邮箱")
    .max(20, "最多填写 20 个邮箱")
    .transform((items) => [...new Set(items)]),
  anonymous: z.boolean(),
  subject: z.string().trim().min(1, "请填写投诉主题").max(200),
  body: z.string().trim().min(1, "请填写投诉正文").max(20000),
});
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
export const accountViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  hasPassword: z.boolean(),
});
export type AccountView = z.infer<typeof accountViewSchema>;
export const complaintViewSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string().optional(),
  anonymous: z.boolean(),
  authorEmail: z.string().nullable(),
  recipients: z.array(z.string()),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type ComplaintView = z.infer<typeof complaintViewSchema>;
export const publicRecipientSchema = z.object({
  email: z.string(),
  complaints: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      authorEmail: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type PublicRecipient = z.infer<typeof publicRecipientSchema>;
