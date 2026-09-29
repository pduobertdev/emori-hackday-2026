import { MATEO_OWNER_ID, USER_OWNER_ID } from "./types";

type SampleEntity = { name: string; kind: "person" | "place" | "event" | "object" | "feeling" | "topic" };

export type SampleMemory = {
  ownerId: string;
  text: string;
  eventDate?: string;
  entities: SampleEntity[];
  relations?: Array<{ from: string; to: string; label: string }>;
};

/**
 * Fictional demo content. Leo's memories and Mateo's curated stories overlap on purpose
 * (a Corolla, Lisbon, pan dulce, the lake) so the graph shows how they connect.
 * Entities are hand-authored and pass through the same validation as model output.
 */
export const SAMPLE_MEMORIES: SampleMemory[] = [
  {
    ownerId: USER_OWNER_ID,
    text: "I bought a used Corolla today, just like the one Dad used to drive. I felt overwhelmed signing all the paperwork in Fresno, but he taught me to read every line.",
    entities: [
      { name: "Corolla", kind: "object" },
      { name: "Dad", kind: "person" },
      { name: "Fresno", kind: "place" },
      { name: "paperwork", kind: "object" },
      { name: "overwhelmed", kind: "feeling" },
    ],
    relations: [{ from: "Dad", to: "Corolla", label: "used to drive" }],
  },
  {
    ownerId: USER_OWNER_ID,
    text: "Dad's old Corolla broke down outside Fresno once, and he fixed it with a hair tie and a lot of patience. I still feel grateful thinking about it.",
    entities: [
      { name: "Dad", kind: "person" },
      { name: "Corolla", kind: "object" },
      { name: "Fresno", kind: "place" },
      { name: "hair tie", kind: "object" },
      { name: "grateful", kind: "feeling" },
    ],
    relations: [{ from: "Dad", to: "Corolla", label: "fixed" }],
  },
  {
    ownerId: USER_OWNER_ID,
    text: "Dad and I drove to Lake Arrowhead every August when I was a kid. He let me steer the boat once we got past the dock, and I felt so proud.",
    entities: [
      { name: "Dad", kind: "person" },
      { name: "Lake Arrowhead", kind: "place" },
      { name: "boat", kind: "object" },
      { name: "proud", kind: "feeling" },
    ],
    relations: [{ from: "Dad", to: "Lake Arrowhead", label: "drove Leo to" }],
  },
  {
    ownerId: USER_OWNER_ID,
    text: "Abuela Lucía made pan dulce every Sunday. The kitchen smelled like cinnamon and I always felt safe there.",
    entities: [
      { name: "Abuela Lucía", kind: "person" },
      { name: "pan dulce", kind: "object" },
      { name: "kitchen", kind: "place" },
      { name: "cinnamon", kind: "object" },
      { name: "safe", kind: "feeling" },
    ],
    relations: [{ from: "Abuela Lucía", to: "pan dulce", label: "made" }],
  },
  {
    ownerId: USER_OWNER_ID,
    text: "My sister Marisol moved to Lisbon in 2019. I missed her the whole first winter and felt lonely on Sundays.",
    eventDate: "2019",
    entities: [
      { name: "Marisol", kind: "person" },
      { name: "Lisbon", kind: "place" },
      { name: "lonely", kind: "feeling" },
    ],
    relations: [{ from: "Marisol", to: "Lisbon", label: "moved to" }],
  },
  {
    ownerId: USER_OWNER_ID,
    text: "In March 2023 we visited Marisol in Lisbon and ate custard tarts on a rattling yellow tram. I have never been so happy.",
    eventDate: "2023-03",
    entities: [
      { name: "Marisol", kind: "person" },
      { name: "Lisbon", kind: "place" },
      { name: "custard tarts", kind: "object" },
      { name: "tram", kind: "object" },
      { name: "happy", kind: "feeling" },
    ],
  },
  {
    ownerId: MATEO_OWNER_ID,
    text: "The Sunday Market: every weekend I walked past a stall selling pan dulce still warm from the oven. The baker, Doña Inés, always gave me the corner piece and told me the edges hold the most sugar. I felt safe in that small, sweet crowd.",
    entities: [
      { name: "Sunday Market", kind: "place" },
      { name: "pan dulce", kind: "object" },
      { name: "Doña Inés", kind: "person" },
      { name: "safe", kind: "feeling" },
    ],
    relations: [{ from: "Doña Inés", to: "pan dulce", label: "sold" }],
  },
  {
    ownerId: MATEO_OWNER_ID,
    text: "A Tram in Lisbon: I once rode the number 28 tram in Lisbon with a paper cone of custard tarts, sticky-fingered and grinning while the tram rattled up the hill. I felt happy in the plainest way.",
    entities: [
      { name: "Lisbon", kind: "place" },
      { name: "tram", kind: "object" },
      { name: "custard tarts", kind: "object" },
      { name: "happy", kind: "feeling" },
    ],
  },
  {
    ownerId: MATEO_OWNER_ID,
    text: "Learning to Read the Fine Print: my first big purchase was a secondhand Corolla. I felt overwhelmed by the paperwork until a friend told me to read slowly and ask one question per page.",
    entities: [
      { name: "Corolla", kind: "object" },
      { name: "paperwork", kind: "object" },
      { name: "overwhelmed", kind: "feeling" },
    ],
  },
  {
    ownerId: MATEO_OWNER_ID,
    text: "The Lake Before Dawn: I used to row out on a still lake before sunrise, when the boat made the only sound. Lake Arrowhead in August is the place I go back to when I need calm.",
    entities: [
      { name: "Lake Arrowhead", kind: "place" },
      { name: "boat", kind: "object" },
      { name: "calm", kind: "feeling" },
    ],
  },
];
