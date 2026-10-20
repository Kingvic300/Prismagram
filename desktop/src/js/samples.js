export const SAMPLES = {
  zoo: `// The classic UML example, written as a Prisma schema.
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// Every animal in the zoo
model Animal {
  id       Int     @id @default(autoincrement())
  age      Int
  gender   String
  isMammal Boolean
  duck     Duck?
  fish     Fish?
  zebra    Zebra?
}

model Duck {
  id        Int    @id @default(autoincrement())
  beakColor String @default("Yellow")
  animal    Animal @relation(fields: [animalId], references: [id])
  animalId  Int    @unique
}

model Fish {
  id       Int     @id @default(autoincrement())
  sizeInFt Int
  canEat   Boolean
  animal   Animal  @relation(fields: [animalId], references: [id])
  animalId Int     @unique
}

model Zebra {
  id       Int     @id @default(autoincrement())
  isWild   Boolean
  animal   Animal  @relation(fields: [animalId], references: [id])
  animalId Int     @unique
}
`,

  blog: `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum Role {
  USER
  EDITOR
  ADMIN
}

/// A registered account
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  createdAt DateTime @default(now())
  posts     Post[]
  comments  Comment[]
  profile   Profile?
}

model Profile {
  id     Int     @id @default(autoincrement())
  bio    String?
  avatar String?
  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId Int     @unique
}

model Post {
  id        Int       @id @default(autoincrement())
  title     String    @db.VarChar(200)
  content   String?
  published Boolean   @default(false)
  updatedAt DateTime  @updatedAt
  author    User      @relation(fields: [authorId], references: [id])
  authorId  Int
  comments  Comment[]
  tags      Tag[]

  @@index([authorId])
}

model Comment {
  id       Int    @id @default(autoincrement())
  body     String
  post     Post   @relation(fields: [postId], references: [id])
  postId   Int
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}

model Tag {
  id    Int    @id @default(autoincrement())
  name  String @unique
  posts Post[]
}
`,

  shop: `datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

enum OrderStatus {
  PENDING
  PAID
  SHIPPED
  CANCELLED
}

model Customer {
  id        String    @id @default(uuid())
  email     String    @unique
  fullName  String
  addresses Address[]
  orders    Order[]
}

model Address {
  id         String   @id @default(uuid())
  line1      String
  city       String
  country    String   @default("NG")
  customer   Customer @relation(fields: [customerId], references: [id])
  customerId String
}

model Order {
  id         String      @id @default(uuid())
  status     OrderStatus @default(PENDING)
  total      Decimal     @db.Decimal(10, 2)
  placedAt   DateTime    @default(now())
  customer   Customer    @relation(fields: [customerId], references: [id])
  customerId String
  items      OrderItem[]
}

model OrderItem {
  quantity  Int
  unitPrice Decimal @db.Decimal(10, 2)
  order     Order   @relation(fields: [orderId], references: [id])
  orderId   String
  product   Product @relation(fields: [productId], references: [id])
  productId String

  @@id([orderId, productId])
}

model Category {
  id       String     @id @default(uuid())
  name     String     @unique
  parent   Category?  @relation("Subcategories", fields: [parentId], references: [id])
  parentId String?
  children Category[] @relation("Subcategories")
  products Product[]
}

model Product {
  id         String      @id @default(uuid())
  sku        String      @unique
  name       String
  price      Decimal     @db.Decimal(10, 2)
  stock      Int         @default(0)
  category   Category    @relation(fields: [categoryId], references: [id])
  categoryId String
  orderItems OrderItem[]
}
`,
};
