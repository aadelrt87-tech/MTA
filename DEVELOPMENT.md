# MTA development rules

Read this before changing the app. The current phase is a frontend-only prototype with no application backend; see `README.md`.

## Architecture rules

- Apps Script is deprecated. Do not reintroduce Apps Script.
- Do not add another temporary backend (fake API, local server, mock remote service or another cloud service).
- Do not create name-based identity relationships. A name, such as an employee name, is display text only and never a key.
- Design new relationships around stable IDs, as Generator and Fuel already do (`generator.id`, `tank.id`).
- Prototype Login must not be treated as security. Neither it nor any other check in the browser controls access.
- Real authority (identity, roles, permissions and validated writes) will come from Supabase Auth, Row Level Security (RLS) and RPC / transactions.

## Approved local prototype persistence

Local persistent prototype state is intentionally limited to:

| Data | localStorage key |
|---|---|
| Generator catalog | `genops_generator_catalog_v1` |
| Generator runs | `genops_generator_runs_v1` |
| Fuel Tanks | `genops_fuel_tanks_v1` |
| Fuel Readings | `genops_fuel_readings_v1` |
| Fuel Movements | `genops_fuel_movements_v1` |

The UI reaches this data only through `generatorRepository` and `fuelRepository`, so that Supabase can replace them later. Every fuel write runs under one Web Lock (`fuelmgrWrite`).

Small UI settings, such as the language and the Prototype Login session, are not data persistence.

Do not add new localStorage-backed subsystems without a clear workflow-testing reason.

## Frozen Ops rule

Generator and Fuel workflows are considered stable for the current phase. Do not modify them unless:

- a reproducible bug is found; or
- the Supabase migration begins.

## Git workflow

Before substantial code changes:

- inspect `git status`;
- create a clean baseline or checkpoint when it is safe to do so;
- do not commit unrelated existing changes blindly, and do not run `git add .` without checking each file.

After a feature is tested and approved:

- create a named Git commit;
- report the commit hash;
- do not push unless explicitly requested.

## Context7

Use Context7 when current official documentation materially affects browser APIs, Supabase, or external libraries and services. It is for verification only and must not justify a redesign.

## نقطة البداية
نسخة Neon المصححة هي الأساس. ينتقل عداد النهاية ووقته من آخر سجل إلى بداية السجل الجديد تلقائياً، مع قفل البداية عن الإدخال اليدوي. نحافظ على هذا السلوك أثناء التطوير.
توقيت العمل: Asia/Baghdad. الواجهة بالعربية والإنجليزية.

## خطة التطوير

هذه مسودة لترتيب الأفكار التي طُرحت، وليست ميزات منفذة أو صلاحيات نهائية.

### المراحل
| الترتيب | المرحلة | النتيجة المطلوبة |
|---|---|---|
| 1 | تشغيل نسخة GitHub TEST | معاينة الواجهة الحالية وتثبيت إصدار يمكن الرجوع إليه |
| 2 | عزل بيانات التجربة | إعداد اتصال مستقل قبل إدخال سجلات تجريبية |
| 3 | رسم تبويب الإدارة | تحديد أقسامه والأدوار وصلاحيات القراءة والإضافة والتعديل |
| 4 | تطوير التصميم | مراجعة الألوان والانتقالات والمقاسات على الموبايل بالعربية والإنجليزية |
| 5 | المخازن وأدوات الفريق | تصميم المواد وحركات الإدخال والصرف والعُهد والإرجاع |
| 6 | التقارير | تحديد الفلاتر والملخصات والتصدير المطلوبة |
| 7 | PWA والإطلاق | تجهيز التثبيت على الموبايل واختبار التحديثات والدخول والحفظ |

### مسودة تبويب الإدارة
| القسم | ما نراجعه قبل تنفيذه |
|---|---|
| المستخدمون | الاسم، حالة الحساب، والدور |
| الأدوار والصلاحيات | تحديد من يقرأ أو يضيف أو يعدّل في كل تبويب؛ وتطبيق القواعد في الخلفية |
| إعدادات التطبيق | اسم التطبيق والإعدادات التي يريد المسؤول إدارتها |
| سجل التغييرات | تحديد العمليات المطلوب تسجيل منفذها ووقتها |

الخلفية المخططة هي Supabase (انظر `README.md`)؛ لم تُنفذ بعد.
لكل مرحلة تغيير محدد، فحص مناسب، وإصدار يمكن الرجوع إليه.
