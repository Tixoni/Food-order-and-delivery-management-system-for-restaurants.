import { gql } from "@apollo/client";

/**
 * Запросы к шлюзу.
 *
 * Собраны в одном месте намеренно: так видно весь объём того, что
 * приложение спрашивает у сервера, и легко заметить, что два экрана
 * просят одно и то же разными словами.
 */

export const RESTAURANTS_NEARBY = gql`
  query RestaurantsNearby($latitude: Float!, $longitude: Float!) {
    restaurantsNearby(latitude: $latitude, longitude: $longitude) {
      id
      name
      minOrderAmount
      deliveryFee
      avgCookingTimeMin
      zone {
        id
        name
      }
    }
  }
`;

export const RESTAURANTS = gql`
  query Restaurants($page: Int!, $pageSize: Int!) {
    restaurants(page: $page, pageSize: $pageSize) {
      total
      page
      pageSize
      items {
        id
        name
        minOrderAmount
        deliveryFee
        avgCookingTimeMin
      }
    }
  }
`;

export const MENU = gql`
  query Menu($restaurantId: ID!, $includeUnavailable: Boolean!) {
    menu(restaurantId: $restaurantId, includeUnavailable: $includeUnavailable) {
      restaurantId
      categories {
        id
        name
        items {
          id
          categoryId
          name
          description
          composition
          price
          imageUrl
          weightGrams
          calories
          isAvailable
          optionGroups {
            id
            name
            selectionType
            isRequired
            minSelect
            maxSelect
            options {
              id
              name
              priceDelta
              isAvailable
            }
          }
        }
      }
    }
  }
`;

export const STOP_LIST = gql`
  query StopList($restaurantId: ID!) {
    stopList(restaurantId: $restaurantId, limit: 20) {
      id
      menuItemId
      reason
      stoppedAt
      restoredAt
      isActive
      outageMinutes
    }
  }
`;

export const SET_AVAILABILITY = gql`
  mutation SetAvailability(
    $itemId: ID!
    $restaurantId: ID!
    $isAvailable: Boolean!
    $reason: String
  ) {
    setMenuItemAvailability(
      itemId: $itemId
      restaurantId: $restaurantId
      isAvailable: $isAvailable
      reason: $reason
    ) {
      itemId
      isAvailable
      changed
    }
  }
`;

export const SAVE_MENU_ITEM = gql`
  mutation SaveMenuItem($input: SaveMenuItemInput!) {
    saveMenuItem(input: $input) {
      id
      name
      price
      description
      isAvailable
    }
  }
`;

export const DELIVERY_ZONES = gql`
  query DeliveryZones($restaurantId: ID!) {
    deliveryZones(restaurantId: $restaurantId) {
      id
      name
      deliveryFee
      minOrderAmount
      isActive
      ring {
        latitude
        longitude
      }
    }
  }
`;

export const SAVE_ZONE = gql`
  mutation SaveZone($input: SaveDeliveryZoneInput!) {
    saveDeliveryZone(input: $input) {
      id
      name
      deliveryFee
      minOrderAmount
      isActive
      ring {
        latitude
        longitude
      }
    }
  }
`;

export const REGISTER_RESTAURANT = gql`
  mutation RegisterRestaurant($input: RegisterRestaurantInput!) {
    registerRestaurant(input: $input) {
      id
      name
      phone
      addressText
      minOrderAmount
      deliveryFee
      isActive
    }
  }
`;

export const MENU_CATEGORIES = gql`
  query MenuCategories($restaurantId: ID!) {
    menuCategories(restaurantId: $restaurantId) {
      id
      name
      sortOrder
      isActive
    }
  }
`;

export const SAVE_CATEGORY = gql`
  mutation SaveMenuCategory($input: SaveMenuCategoryInput!) {
    saveMenuCategory(input: $input) {
      id
      name
      sortOrder
      isActive
    }
  }
`;

export const REPLACE_MODIFIERS = gql`
  mutation ReplaceModifiers($itemId: ID!, $restaurantId: ID!, $groups: [ModifierGroupInput!]!) {
    replaceModifiers(itemId: $itemId, restaurantId: $restaurantId, groups: $groups) {
      id
    }
  }
`;

export const REMOVE_MENU_ITEM = gql`
  mutation RemoveMenuItem($itemId: ID!, $restaurantId: ID!) {
    removeMenuItem(itemId: $itemId, restaurantId: $restaurantId)
  }
`;

export const UPDATE_RESTAURANT = gql`
  mutation UpdateRestaurant(
    $restaurantId: ID!
    $input: RegisterRestaurantInput!
    $isActive: Boolean
  ) {
    updateRestaurant(restaurantId: $restaurantId, input: $input, isActive: $isActive) {
      id
      name
      isActive
    }
  }
`;

export const RESTAURANT = gql`
  query Restaurant($id: ID!) {
    restaurant(id: $id) {
      id
      name
      minOrderAmount
      deliveryFee
      avgCookingTimeMin
    }
  }
`;

/* ─────────────── Заказы клиента ─────────────── */

const ORDER_FIELDS = gql`
  fragment OrderFields on Order {
    id
    orderNumber
    status
    restaurantId
    restaurant {
      id
      name
    }
    addressText
    comment
    amounts {
      items
      delivery
      service
      discount
      total
    }
    lines {
      menuItemId
      name
      quantity
      unitPrice
      lineTotal
      options {
        optionId
        name
        priceDelta
      }
    }
    expectedCookingMin
    placedAt
    confirmedAt
    readyAt
    pickedUpAt
    deliveredAt
    cancelledAt
    cancelReason
    cancelComment
    canCancel
  }
`;

export const PLACE_ORDER = gql`
  ${ORDER_FIELDS}
  mutation PlaceOrder($input: PlaceOrderInput!) {
    placeOrder(input: $input) {
      replayed
      order {
        ...OrderFields
      }
    }
  }
`;

export const MY_ORDERS = gql`
  ${ORDER_FIELDS}
  query MyOrders($limit: Int!, $offset: Int!) {
    myOrders(limit: $limit, offset: $offset) {
      ...OrderFields
    }
  }
`;

export const ORDER = gql`
  ${ORDER_FIELDS}
  query Order($id: ID!) {
    order(id: $id) {
      ...OrderFields
    }
    orderTransitions(id: $id) {
      from
      to
      actorType
      reason
      at
    }
  }
`;

export const CANCEL_ORDER = gql`
  ${ORDER_FIELDS}
  mutation CancelOrder($id: ID!, $reason: String) {
    cancelOrder(id: $id, reason: $reason) {
      ...OrderFields
    }
  }
`;

/* ─────────────── Типы ответов ─────────────── */

export interface RestaurantSummary {
  id: string;
  name: string;
  minOrderAmount: number;
  deliveryFee: number;
  avgCookingTimeMin: number;
  zone?: { id: string; name: string };
}

export interface MenuOption {
  id: string;
  name: string;
  priceDelta: number;
  isAvailable: boolean;
}

export interface MenuOptionGroup {
  id: string;
  name: string;
  selectionType: "single" | "multiple";
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  options: MenuOption[];
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  composition: string | null;
  price: number;
  imageUrl: string | null;
  weightGrams: number | null;
  calories: number | null;
  isAvailable: boolean;
  optionGroups: MenuOptionGroup[];
}

export interface MenuSection {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface StopListEntry {
  id: string;
  menuItemId: string;
  reason: string | null;
  stoppedAt: string;
  restoredAt: string | null;
  isActive: boolean;
  outageMinutes: number;
}

export interface ZonePoint {
  latitude: number;
  longitude: number;
}

export interface DeliveryZone {
  id: string;
  name: string;
  deliveryFee: number;
  minOrderAmount: number;
  isActive: boolean;
  ring: ZonePoint[];
}

export interface MenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface RestaurantDetails {
  id: string;
  name: string;
  phone: string | null;
  addressText: string | null;
  minOrderAmount: number;
  deliveryFee: number;
  isActive: boolean;
}

export interface OrderLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  options: Array<{ optionId: string; name: string; priceDelta: number }>;
}

export interface Order {
  id: string;
  orderNumber: number;
  status: string;
  restaurantId: string;
  restaurant: { id: string; name: string } | null;
  addressText: string;
  comment: string | null;
  amounts: { items: number; delivery: number; service: number; discount: number; total: number };
  lines: OrderLine[];
  expectedCookingMin: number | null;
  placedAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelComment: string | null;
  canCancel: boolean;
}

export interface OrderTransition {
  from: string | null;
  to: string;
  actorType: string;
  reason: string | null;
  at: string;
}
