/**
 * The invented workspaces and chats of the demonstration home. Nothing here names a real person, folder, address or
 * key; the projects and conversations exist only to give the pictures believable content.
 * @module @delorun/tools/demo-home/content
 */

/** One turn of an invented chat: what the person asked and what the model answered. */
export interface DemoTurn {
  /** The person's message. */
  readonly ask: string
  /** The model's answer, in Markdown. */
  readonly answer: string
}

/** One invented chat. */
export interface DemoChat {
  /** The chat's title as the sidebar shows it. */
  readonly title: string
  /** How long before the build time the last message was written, in minutes. */
  readonly minutesAgo: number
  /** The turns, oldest first. */
  readonly turns: readonly DemoTurn[]
}

/** One invented workspace: a folder with a few files, and the chats in it. */
export interface DemoWorkspace {
  /** The folder name below the projects folder; the studio titles the workspace with it. */
  readonly folder: string
  /** The files to write, by path below the folder. */
  readonly files: Readonly<Record<string, string>>
  /** The chats, in any order. */
  readonly chats: readonly DemoChat[]
}

/** The workspaces of the demonstration home. */
export const DEMO_WORKSPACES: readonly DemoWorkspace[] = [
  {
    folder: 'garden-planner',
    files: {
      'README.md': '# Garden planner\n\nA small tool that lays out raised beds and a sowing calendar for one allotment.\n',
      'beds.json': '{\n  "plot": { "width": 4, "depth": 3 },\n  "beds": ["tomatoes", "beans", "lettuce", "herbs"]\n}\n',
      'calendar.ts': 'export const sowing = {\n  tomatoes: [3, 4],\n  beans: [5, 6],\n  lettuce: [3, 4, 5, 6, 7, 8],\n  herbs: [4, 5],\n}\n',
    },
    chats: [
      {
        title: 'Lay out four raised beds',
        minutesAgo: 25,
        turns: [
          {
            ask: 'The plot is 4 m by 3 m. Can you lay out four raised beds for tomatoes, beans, lettuce and herbs, with a path wide enough for a wheelbarrow?',
            answer: 'Yes. A path of 80 cm between the beds takes a wheelbarrow, and four beds of 1.4 m by 1.0 m fit with room for a path along one edge.\n\n| Bed | Size | Position | Why there |\n| --- | --- | --- | --- |\n| Tomatoes | 1.4 m × 1.0 m | North-west | Tallest crop, so it shades nothing |\n| Beans | 1.4 m × 1.0 m | North-east | Climbs a frame on the north side |\n| Lettuce | 1.4 m × 1.0 m | South-west | Likes the lower afternoon light |\n| Herbs | 1.4 m × 1.0 m | South-east | Close to the gate for picking |\n\nI can write this into `beds.json` if you want it kept.',
          },
          {
            ask: 'Yes, write it into beds.json.',
            answer: 'I updated `beds.json` with the four beds, their sizes and positions, and left the plot size as it was.\n\n```json\n{\n  "plot": { "width": 4, "depth": 3 },\n  "path": 0.8,\n  "beds": [\n    { "crop": "tomatoes", "at": "north-west", "size": [1.4, 1.0] },\n    { "crop": "beans", "at": "north-east", "size": [1.4, 1.0] },\n    { "crop": "lettuce", "at": "south-west", "size": [1.4, 1.0] },\n    { "crop": "herbs", "at": "south-east", "size": [1.4, 1.0] }\n  ]\n}\n```',
          },
        ],
      },
      {
        title: 'Why the sowing calendar skips February',
        minutesAgo: 60 * 5,
        turns: [
          {
            ask: 'calendar.ts never lists month 2 for anything. Is that a bug?',
            answer: 'It is deliberate for these crops: nothing in the list can be sown outdoors in February in a cool climate. Tomatoes start indoors in March, and the first lettuce goes out in March too.\n\nIf you want February to appear, add an `indoors` list beside each crop, so the calendar can tell outdoor sowing from sowing on a windowsill.',
          },
        ],
      },
      {
        title: 'Add a watering reminder',
        minutesAgo: 60 * 26,
        turns: [
          {
            ask: 'Add a function that says which beds need watering today, given the days since the last rain.',
            answer: 'Here is a small function. Lettuce and herbs dry out first, so they use a shorter limit.\n\n```ts\nconst limits = { tomatoes: 3, beans: 3, lettuce: 2, herbs: 2 }\n\nexport function needsWater(daysSinceRain: number): string[] {\n  return Object.entries(limits)\n    .filter(([, limit]) => daysSinceRain >= limit)\n    .map(([crop]) => crop)\n}\n```\n\nWith two dry days it returns `lettuce` and `herbs`.',
          },
        ],
      },
    ],
  },
  {
    folder: 'recipe-box',
    files: {
      'README.md': '# Recipe box\n\nRecipes as plain Markdown files, with a script that scales the quantities.\n',
      'soup.md': '# Tomato soup\n\n- 800 g tomatoes\n- 1 onion\n- 2 cloves garlic\n- 500 ml stock\n',
    },
    chats: [
      {
        title: 'Scale a recipe for twelve',
        minutesAgo: 60 * 3,
        turns: [
          {
            ask: 'soup.md serves four. What do I need for twelve?',
            answer: 'Multiply every quantity by three:\n\n- 2.4 kg tomatoes\n- 3 onions\n- 6 cloves garlic\n- 1.5 litres stock\n\nA pot for twelve takes longer to come to the boil, so allow ten extra minutes before you season.',
          },
        ],
      },
      {
        title: 'Tidy the ingredient parser',
        minutesAgo: 60 * 50,
        turns: [
          {
            ask: 'The parser fails on "1/2 tsp salt". Can you fix it?',
            answer: 'The parser read the quantity as a whole number. I changed it to accept a fraction, so `1/2` becomes `0.5`, and added a test for it.',
          },
        ],
      },
    ],
  },
  {
    folder: 'trail-notes',
    files: { 'README.md': '# Trail notes\n\nWalks written up as short notes.\n' },
    chats: [
      {
        title: 'Summarise the ridge walk',
        minutesAgo: 60 * 80,
        turns: [
          {
            ask: 'Turn my notes from the ridge walk into three sentences for the club newsletter.',
            answer: 'We left the car park at nine and followed the ridge in clear weather, with the valley below us for most of the climb. The path was dry, though the last kilometre to the summit needed some care on loose stone. We were back by two, and everyone agreed the view from the top was worth the early start.',
          },
        ],
      },
    ],
  },
]
